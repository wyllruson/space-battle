// --- Constants & state ---

const ROCKET_BASE_SPEED = 6.5;
const ROCKET_ICON_ALIGNMENT_DEGREES = 45;
const LEADERBOARD_KEY = 'spaceBattleLeaderboard';
const LEADERBOARD_SYNC_KEY = 'spaceBattleLeaderboardSync';
const MAX_LEADERBOARD_ENTRIES = 6;
const MAX_NAME_LENGTH = 50;
const DEFAULT_ROCKET_RADIUS = 8;
const DEFAULT_ENEMY_RADIUS = 16;
const ROCKET_WRAP_GHOST_COUNT = 4;
// FA solid glyphs paint inside ~0.88em diameter; circle radius from em center.
const ICON_GLYPH_RADIUS_EM = 0.44;
const COLLISION_RING_SCALE = 2.5;
const COLLISION_TOUCH_EPSILON = 0.5;
const ROCKET_MARKUP = '<i class="fa-solid fa-fire rocket-flame"></i><i class="fa-solid fa-rocket fa-beat rocket-body" style="color: #ffdf00;"></i>';

let score = 0;
let scoreRecordedThisSession = false;
let highlightedLeaderboardIndex = -1;
let rocket;
let activeMovementKeys = { up: false, down: false, left: false, right: false };
let canvasUiHidden = false;
let leaderboardSyncChannel = null;
let leaderboardPollInterval = null;
let leaderboardEntries = [];
let supabaseClient = null;
let leaderboardRealtimeChannel = null;
let projectiles = [];
let enemies = [];
let enemyProjectiles = [];
let rocketWrapGhosts = [];
let dialogResolve = null;

const domCache = {};

// --- DOM utilities ---

function el(id) {
    return domCache[id] ?? (domCache[id] = document.getElementById(id));
}

function getSpriteContainer() {
    return el('playArea');
}

function getCollisionEffectsContainer() {
    return el('collisionEffects');
}

function getEnemyStagingContainer() {
    return el('enemyStaging');
}

function getRocketElement() {
    return document.querySelector('.rocket:not(.rocket-wrap-ghost)');
}

function setSpritePosition(element, x, y) {
    element.style.left = x + 'px';
    element.style.top = y + 'px';
}

function appendEnemyToStaging(element) {
    element.style.left = '';
    element.style.top = '';
    getEnemyStagingContainer().appendChild(element);
}

function ensureSpriteInPlayArea(element) {
    const container = getSpriteContainer();
    if (element.parentElement !== container) {
        container.appendChild(element);
    }
}

function getCanvasOffset() {
    const game = el('game');
    const playArea = el('playArea');
    if (!game || !playArea) {
        return { x: 280, y: 8 };
    }
    const gameRect = game.getBoundingClientRect();
    const playRect = playArea.getBoundingClientRect();
    return {
        x: playRect.left - gameRect.left,
        y: playRect.top - gameRect.top
    };
}

// --- Canvas utilities ---

function getPlayAreaSize() {
    const canvas = myGameArea.canvas;
    return { width: canvas.width, height: canvas.height };
}

function getCanvasDisplayScale() {
    const canvas = myGameArea.canvas;
    if (!canvas) {
        return { x: 1, y: 1 };
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
        return { x: 1, y: 1 };
    }
    return {
        x: canvas.width / rect.width,
        y: canvas.height / rect.height
    };
}

function wrapCanvasCoord(coord, extent) {
    coord %= extent;
    if (coord < 0) {
        coord += extent;
    }
    return coord;
}

function drawClippedCircle(x, y, radius, fillStyle) {
    const ctx = myGameArea.context;
    const { width, height } = getPlayAreaSize();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.closePath();
    ctx.restore();
}

function isCircleFullyOutsideCanvas(x, y, radius) {
    const { width, height } = getPlayAreaSize();
    return (
        x + radius < 0 ||
        x - radius > width ||
        y + radius < 0 ||
        y - radius > height
    );
}

// --- Collision detection ---

function getCollisionTargetElement(element) {
    if (!element) {
        return element;
    }
    // Rocket flame is visual-only and must never contribute to hitbox.
    if (element.classList && element.classList.contains('rocket')) {
        return element.querySelector('.rocket-body') || element;
    }
    return element.querySelector('i') || element;
}

function getIconGlyphRadiusPx(iconElement, displayScale) {
    const fontSize = parseFloat(window.getComputedStyle(iconElement).fontSize);
    if (!fontSize || Number.isNaN(fontSize)) {
        return null;
    }
    return fontSize * ICON_GLYPH_RADIUS_EM * displayScale.x;
}

function getVisualCircleForElement(element, fallbackRadius, fallbackX, fallbackY) {
    const displayScale = getCanvasDisplayScale();
    const fallback = {
        x: fallbackX * displayScale.x,
        y: fallbackY * displayScale.y,
        radius: fallbackRadius * displayScale.x
    };
    if (!element || !myGameArea.canvas) {
        return fallback;
    }
    const target = getCollisionTargetElement(element);
    const targetRect = target.getBoundingClientRect();
    const canvasRect = myGameArea.canvas.getBoundingClientRect();
    if (!targetRect.width || !targetRect.height) {
        return fallback;
    }
    const glyphRadius = target.tagName === 'I' ? getIconGlyphRadiusPx(target, displayScale) : null;
    const bboxRadius = (Math.min(targetRect.width, targetRect.height) / 2) * displayScale.x;
    return {
        x: (targetRect.left - canvasRect.left + (targetRect.width / 2)) * displayScale.x,
        y: (targetRect.top - canvasRect.top + (targetRect.height / 2)) * displayScale.y,
        // Icon glyphs use em-based radius (ignores fa-shake/fa-beat bbox inflation).
        radius: glyphRadius !== null ? glyphRadius : bboxRadius
    };
}

function getProjectileCircle(projectile) {
    return { x: projectile.x, y: projectile.y, radius: projectile.size };
}

function getEnemyCircle(enemy) {
    return getVisualCircleForElement(enemy.element, DEFAULT_ENEMY_RADIUS, enemy.x, enemy.y);
}

function circlesTouch(circleA, circleB) {
    const deltaX = circleA.x - circleB.x;
    const deltaY = circleA.y - circleB.y;
    const touchDistance = circleA.radius + circleB.radius + COLLISION_TOUCH_EPSILON;
    return (deltaX * deltaX) + (deltaY * deltaY) <= (touchDistance * touchDistance);
}

function clearCollisionEffects() {
    const container = getCollisionEffectsContainer();
    if (container) {
        container.replaceChildren();
    }
}

function showCollisionRing(x, y, radius) {
    const container = getCollisionEffectsContainer();
    if (!container) {
        return;
    }
    const ring = document.createElement('div');
    ring.className = 'collision-ring';
    const diameter = radius * 2 * COLLISION_RING_SCALE;
    ring.style.width = diameter + 'px';
    ring.style.height = diameter + 'px';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    container.appendChild(ring);
}

function getRocketWrapMargin() {
    const rocketElement = getRocketElement();
    if (rocketElement && rocketElement.offsetWidth) {
        return (Math.max(rocketElement.offsetWidth, rocketElement.offsetHeight) / 2) + 2;
    }
    return DEFAULT_ROCKET_RADIUS + 4;
}

function getRocketWrapOffsets(x, y, width, height, margin) {
    const offsets = [];
    const nearLeft = x < margin;
    const nearRight = x > width - margin;
    const nearTop = y < margin;
    const nearBottom = y > height - margin;

    if (nearLeft) {
        offsets.push({ dx: width, dy: 0 });
    }
    if (nearRight) {
        offsets.push({ dx: -width, dy: 0 });
    }
    if (nearTop) {
        offsets.push({ dx: 0, dy: height });
    }
    if (nearBottom) {
        offsets.push({ dx: 0, dy: -height });
    }
    if (nearLeft && nearTop) {
        offsets.push({ dx: width, dy: height });
    }
    if (nearRight && nearTop) {
        offsets.push({ dx: -width, dy: height });
    }
    if (nearLeft && nearBottom) {
        offsets.push({ dx: width, dy: -height });
    }
    if (nearRight && nearBottom) {
        offsets.push({ dx: -width, dy: -height });
    }
    return offsets;
}

function getRocketWrapContext() {
    const { width, height } = getPlayAreaSize();
    const margin = getRocketWrapMargin();
    return {
        width,
        height,
        margin,
        offsets: getRocketWrapOffsets(rocket.x, rocket.y, width, height, margin)
    };
}

function getRocketCollisionCircles() {
    if (!rocket) {
        return [];
    }
    const primary = getVisualCircleForElement(
        getRocketElement(),
        DEFAULT_ROCKET_RADIUS,
        rocket.x,
        rocket.y
    );
    const { offsets } = getRocketWrapContext();
    return [
        primary,
        ...offsets.map((offset) => ({
            x: primary.x + offset.dx,
            y: primary.y + offset.dy,
            radius: primary.radius
        }))
    ];
}

function getCollisionRingCenter(rocketCircle, otherX, otherY) {
    const deltaX = otherX - rocketCircle.x;
    const deltaY = otherY - rocketCircle.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (!distance) {
        return { x: rocketCircle.x, y: rocketCircle.y };
    }
    return {
        x: rocketCircle.x + (deltaX / distance) * rocketCircle.radius,
        y: rocketCircle.y + (deltaY / distance) * rocketCircle.radius
    };
}

function handleRocketHit(rocketCircle, otherX, otherY) {
    const contact = getCollisionRingCenter(rocketCircle, otherX, otherY);
    showCollisionRing(contact.x, contact.y, rocketCircle.radius);
    myGameArea.stop();
}

function findRocketCollision(rocketCircle, targets, getCircle) {
    for (const target of targets) {
        const circle = getCircle(target);
        if (circlesTouch(rocketCircle, circle)) {
            return { rocketCircle, otherX: circle.x, otherY: circle.y };
        }
    }
    return null;
}

function checkRocketCollisions() {
    for (const rocketCircle of getRocketCollisionCircles()) {
        const hit = findRocketCollision(rocketCircle, enemies, getEnemyCircle)
            ?? findRocketCollision(rocketCircle, enemyProjectiles, getProjectileCircle);
        if (hit) {
            handleRocketHit(hit.rocketCircle, hit.otherX, hit.otherY);
            return;
        }
    }
}

// --- Game area & loop ---

const myGameArea = {
    canvas: null,
    initialized: false,
    start() {
        if (!this.initialized) {
            this.canvas = el('gameCanvas');
            this.context = this.canvas.getContext('2d');
            getSpriteContainer().addEventListener('click', shootProjectile);
            this.initialized = true;
        }
        this.run();
    },
    run() {
        getSpriteContainer().classList.add('is-playing');
        createRocket();
        this.interval = setInterval(updateGameArea, 20);
        this.enemySpawnInterval = setInterval(spawnEnemy, 1000);
    },
    clear() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    },
    stop() {
        getSpriteContainer().classList.remove('is-playing');
        clearInterval(this.interval);
        clearInterval(this.enemySpawnInterval);
        this.interval = null;
        this.enemySpawnInterval = null;
        spawnEnemy();
        scoreRecordedThisSession = false;
        setCanvasUiHidden(false);
        el('gameOver').style.display = 'block';
        centerGameOver();
        el('leaderboard').style.display = 'block';
        refreshLeaderboard().then(syncLeaderboardPolling);
        positionLeaderboard();
        el('gameOverActions').style.display = 'flex';
        positionGameOverActions();
        el('uiToggle').style.display = 'block';
    },
    reset() {
        this.clear();
        projectiles = [];
        enemies = [];
        enemyProjectiles = [];
        document.querySelectorAll('.rocket').forEach((element) => element.remove());
        rocketWrapGhosts = [];
        clearCollisionEffects();
        document.querySelectorAll('.game-enemy').forEach((element) => element.remove());
        score = 0;
        setCanvasUiHidden(false);
        el('leaderboard').style.display = 'none';
        el('gameOver').style.display = 'none';
        el('gameOverActions').style.display = 'none';
        el('uiToggle').style.display = 'none';
        closeLeaderboardModal();
        closeGameDialog(null);
        scoreRecordedThisSession = false;
        highlightedLeaderboardIndex = -1;
        syncLeaderboardPolling();
        this.run();
    },
};

function startGame() {
    el('startOverlay').style.display = 'none';
    myGameArea.start();
}

function updateGameArea() {
    myGameArea.clear();
    moveRocketPosition();
    drawRocket();
    updateProjectiles();
    updateEnemies();
    updateEnemyProjectiles();
    checkRocketCollisions();
    score++;
    showScore();
}

// --- Rocket ---

function createRocket() {
    resetMovementState();
    rocket = {
        x: myGameArea.canvas.width / 2,
        y: myGameArea.canvas.height / 2,
        speed: ROCKET_BASE_SPEED,
        direction: { x: 0, y: 0 }
    };
    const rocketIcon = document.createElement('div');
    rocketIcon.className = 'rocket';
    rocketIcon.innerHTML = ROCKET_MARKUP;
    setSpritePosition(rocketIcon, rocket.x, rocket.y);
    getSpriteContainer().appendChild(rocketIcon);

    rocketWrapGhosts = [];
    for (let i = 0; i < ROCKET_WRAP_GHOST_COUNT; i++) {
        const ghost = document.createElement('div');
        ghost.className = 'rocket rocket-wrap-ghost';
        ghost.innerHTML = ROCKET_MARKUP;
        ghost.style.display = 'none';
        ghost.setAttribute('aria-hidden', 'true');
        getSpriteContainer().appendChild(ghost);
        rocketWrapGhosts.push(ghost);
    }
}

function drawRocket() {
    const rocketIcon = getRocketElement();
    if (!rocketIcon || !rocket) {
        return;
    }
    setSpritePosition(rocketIcon, rocket.x, rocket.y);
    const isMoving = rocket.direction.x !== 0 || rocket.direction.y !== 0;
    rocketIcon.classList.toggle('is-moving', isMoving);
    if (isMoving) {
        const movementAngle = Math.atan2(rocket.direction.y, rocket.direction.x);
        const rotation = movementAngle * (180 / Math.PI) + ROCKET_ICON_ALIGNMENT_DEGREES;
        rocketIcon.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }
    updateRocketWrapGhosts(rocketIcon);
}

function moveRocketPosition() {
    rocket.x += rocket.direction.x;
    rocket.y += rocket.direction.y;
    const { width, height } = getPlayAreaSize();
    rocket.x = wrapCanvasCoord(rocket.x, width);
    rocket.y = wrapCanvasCoord(rocket.y, height);
}

function updateRocketWrapGhosts(primaryElement) {
    const { offsets } = getRocketWrapContext();
    let ghostIndex = 0;
    for (const offset of offsets) {
        if (ghostIndex >= rocketWrapGhosts.length) {
            break;
        }
        const ghost = rocketWrapGhosts[ghostIndex++];
        ghost.style.display = '';
        setSpritePosition(ghost, rocket.x + offset.dx, rocket.y + offset.dy);
        ghost.style.transform = primaryElement.style.transform;
        ghost.classList.toggle('is-moving', primaryElement.classList.contains('is-moving'));
    }
    for (let i = ghostIndex; i < rocketWrapGhosts.length; i++) {
        rocketWrapGhosts[i].style.display = 'none';
    }
}

// --- Input ---

function isTypingInFormField() {
    const active = document.activeElement;
    return Boolean(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable));
}

function isArrowKey(key) {
    return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}

function isScrollKey(key) {
    return isArrowKey(key) ||
        key === ' ' ||
        key === 'Spacebar' ||
        key === 'PageUp' ||
        key === 'PageDown' ||
        key === 'Home' ||
        key === 'End';
}

function preventKeyboardPageScroll(e) {
    if (isScrollKey(e.key) && !isTypingInFormField()) {
        e.preventDefault();
    }
}

function preventKeyboardButtonActivation(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('button')) {
        e.preventDefault();
    }
}

function setupMouseOnlyButtons() {
    document.querySelectorAll('button').forEach((button) => {
        button.tabIndex = -1;
    });

    document.addEventListener('pointerdown', (e) => {
        const button = e.target.closest('button');
        if (!button) {
            return;
        }
        if (e.pointerType === 'mouse') {
            e.preventDefault();
            button.dataset.mouseClick = 'true';
            return;
        }
        e.preventDefault();
    }, true);

    document.addEventListener('pointerup', () => {
        document.querySelectorAll('button').forEach((button) => {
            if (document.activeElement === button) {
                button.blur();
            }
        });
        requestAnimationFrame(() => {
            document.querySelectorAll('button').forEach((button) => {
                delete button.dataset.mouseClick;
            });
        });
    }, true);

    document.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button) {
            return;
        }
        if (button.dataset.mouseClick !== 'true') {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        delete button.dataset.mouseClick;
        button.blur();
    }, true);
}

function shouldCaptureMovementKeys() {
    if (el('gameDialog').classList.contains('is-open')) {
        return false;
    }
    if (isTypingInFormField()) {
        return false;
    }
    return Boolean(rocket && myGameArea.interval);
}

function moveRocket(e) {
    preventKeyboardPageScroll(e);
    preventKeyboardButtonActivation(e);
    if (!shouldCaptureMovementKeys()) return;
    if (setMovementKeyState(e.key, true)) {
        updateRocketDirectionFromKeys();
    }
}

function stopRocket(e) {
    preventKeyboardPageScroll(e);
    if (!shouldCaptureMovementKeys()) return;
    if (setMovementKeyState(e.key, false)) {
        updateRocketDirectionFromKeys();
    }
}

function setMovementKeyState(key, isPressed) {
    const normalized = key.length === 1 ? key.toLowerCase() : key;
    switch (normalized) {
        case 'ArrowUp':
        case 'w':
            activeMovementKeys.up = isPressed;
            return true;
        case 'ArrowDown':
        case 's':
            activeMovementKeys.down = isPressed;
            return true;
        case 'ArrowLeft':
        case 'a':
            activeMovementKeys.left = isPressed;
            return true;
        case 'ArrowRight':
        case 'd':
            activeMovementKeys.right = isPressed;
            return true;
        default:
            return false;
    }
}

function updateRocketDirectionFromKeys() {
    const horizontalAxis = (activeMovementKeys.right ? 1 : 0) - (activeMovementKeys.left ? 1 : 0);
    const verticalAxis = (activeMovementKeys.down ? 1 : 0) - (activeMovementKeys.up ? 1 : 0);
    if (horizontalAxis === 0 && verticalAxis === 0) {
        rocket.direction.x = 0;
        rocket.direction.y = 0;
        return;
    }
    const length = Math.hypot(horizontalAxis, verticalAxis);
    rocket.direction.x = (horizontalAxis / length) * rocket.speed;
    rocket.direction.y = (verticalAxis / length) * rocket.speed;
}

function resetMovementState() {
    activeMovementKeys.up = false;
    activeMovementKeys.down = false;
    activeMovementKeys.left = false;
    activeMovementKeys.right = false;
    if (rocket) {
        rocket.direction.x = 0;
        rocket.direction.y = 0;
    }
}

function shouldShootOnClick(event) {
    if (!rocket || !myGameArea.interval) {
        return false;
    }
    if (el('gameDialog').classList.contains('is-open')) {
        return false;
    }
    if (el('leaderboardModal').classList.contains('is-open')) {
        return false;
    }
    if (el('startOverlay').style.display !== 'none') {
        return false;
    }
    if (event.target.closest('button, input, a, textarea, select, label')) {
        return false;
    }
    return true;
}

// --- Projectiles ---

function createProjectile({ x, y, angle, speed, size }) {
    return {
        x,
        y,
        size,
        speed,
        angle,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed
    };
}

function updateProjectileList(list, color, onUpdate) {
    for (let i = list.length - 1; i >= 0; i--) {
        const projectile = list[i];
        projectile.x += projectile.velocityX;
        projectile.y += projectile.velocityY;
        if (isCircleFullyOutsideCanvas(projectile.x, projectile.y, projectile.size)) {
            list.splice(i, 1);
            continue;
        }
        drawClippedCircle(projectile.x, projectile.y, projectile.size, color);
        onUpdate?.(projectile, i);
    }
}

function shootProjectile(event) {
    if (!shouldShootOnClick(event)) return;
    const rocketVisualCircle = getVisualCircleForElement(
        getRocketElement(),
        DEFAULT_ROCKET_RADIUS,
        rocket.x,
        rocket.y
    );
    const canvasRect = myGameArea.canvas.getBoundingClientRect();
    const scale = getCanvasDisplayScale();
    const angle = Math.atan2(
        ((event.clientY - canvasRect.top) * scale.y) - rocketVisualCircle.y,
        ((event.clientX - canvasRect.left) * scale.x) - rocketVisualCircle.x
    );
    const speed = Math.random() * 14 + 3;
    projectiles.push(createProjectile({
        x: rocketVisualCircle.x,
        y: rocketVisualCircle.y,
        angle,
        speed,
        size: Math.random() * 17
    }));
}

function updateProjectiles() {
    updateProjectileList(projectiles, 'blue', checkCollisions);
}

function checkCollisions(projectile, projectileIndex) {
    for (let j = enemies.length - 1; j >= 0; j--) {
        const enemy = enemies[j];
        if (circlesTouch(getProjectileCircle(projectile), getEnemyCircle(enemy))) {
            enemies.splice(j, 1);
            enemy.element.remove();
            projectiles.splice(projectileIndex, 1);
            break;
        }
    }
}

function updateEnemyProjectiles() {
    updateProjectileList(enemyProjectiles, 'red');
}

// --- Enemies ---

function spawnEnemy() {
    const side = Math.floor(Math.random() * 4);
    const enemy = {
        x: 0,
        y: 0,
        speed: 1,
        direction: { x: 0, y: 0 },
        element: null
    };
    const { width, height } = getPlayAreaSize();
    if (side === 0) {
        enemy.x = 0;
        enemy.y = Math.random() * height;
        enemy.direction.x = 1;
    } else if (side === 1) {
        enemy.x = width;
        enemy.y = Math.random() * height;
        enemy.direction.x = -1;
    } else if (side === 2) {
        enemy.x = Math.random() * width;
        enemy.y = 0;
        enemy.direction.y = 1;
    } else {
        enemy.x = Math.random() * width;
        enemy.y = height;
        enemy.direction.y = -1;
    }
    enemy.element = document.createElement('div');
    enemy.element.className = 'enemy game-enemy';
    enemy.element.innerHTML = '<i class="fa-solid fa-spaghetti-monster-flying fa-shake" style="color: #ff0000;"></i>';
    appendEnemyToStaging(enemy.element);
    enemies.push(enemy);
}

function updateEnemies() {
    for (let i = enemies.length - 1; i >= 0; i--) {
        const enemy = enemies[i];
        enemy.x += enemy.direction.x * enemy.speed;
        enemy.y += enemy.direction.y * enemy.speed;
        const angle = Math.atan2(enemy.direction.y, enemy.direction.x);
        const rotation = angle * (180 / Math.PI) + 90;
        ensureSpriteInPlayArea(enemy.element);
        setSpritePosition(enemy.element, enemy.x, enemy.y);
        enemy.element.style.setProperty('--enemy-rotation', `${rotation}deg`);
        const enemyCircle = getEnemyCircle(enemy);
        if (isCircleFullyOutsideCanvas(enemyCircle.x, enemyCircle.y, enemyCircle.radius)) {
            enemies.splice(i, 1);
            enemy.element.remove();
        } else if (Math.random() < 0.01) {
            shootEnemyProjectile(enemy);
        }
    }
}

function shootEnemyProjectile(enemy) {
    const spawn = getEnemyCircle(enemy);
    const angle = Math.atan2(enemy.direction.y, enemy.direction.x);
    const speed = Math.random() * 10 + 2;
    enemyProjectiles.push(createProjectile({
        x: spawn.x,
        y: spawn.y,
        angle,
        speed,
        size: Math.random() * 51 + 6
    }));
}

// --- Leaderboard ---

function isSupabaseConfigured() {
    return typeof SUPABASE_CONFIG !== 'undefined'
        && SUPABASE_CONFIG.url
        && SUPABASE_CONFIG.anonKey
        && SUPABASE_CONFIG.anonKey !== 'YOUR_ANON_KEY_HERE';
}

function initSupabaseClient() {
    if (!isSupabaseConfigured() || typeof supabase === 'undefined') {
        return null;
    }
    return supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
}

function getLeaderboardFromLocalStorage() {
    try {
        const stored = localStorage.getItem(LEADERBOARD_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function saveLeaderboardCache(entries) {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(entries));
}

function notifyLeaderboardUpdate() {
    const timestamp = Date.now().toString();
    try {
        localStorage.setItem(LEADERBOARD_SYNC_KEY, timestamp);
    } catch {
        // Ignore storage write failures (private mode/quota) and continue.
    }
    if (leaderboardSyncChannel) {
        leaderboardSyncChannel.postMessage(timestamp);
    }
}

async function fetchRemoteLeaderboard() {
    const { data, error } = await supabaseClient
        .from('scores')
        .select('name, score')
        .order('score', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(MAX_LEADERBOARD_ENTRIES);
    if (error) {
        console.warn('Leaderboard fetch failed:', error.message);
        return null;
    }
    return data || [];
}

function findLeaderboardHighlightIndex(entries, name, entryScore) {
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].name === name && entries[i].score === entryScore) {
            return i;
        }
    }
    return -1;
}

async function refreshLeaderboard() {
    if (supabaseClient) {
        const entries = await fetchRemoteLeaderboard();
        if (entries !== null) {
            leaderboardEntries = entries;
            saveLeaderboardCache(entries);
        }
    }
    renderLeaderboard();
}

function isLeaderboardUiVisible() {
    const leaderboardShown = el('leaderboard') && el('leaderboard').style.display !== 'none';
    const modalOpen = el('leaderboardModal') && el('leaderboardModal').classList.contains('is-open');
    return leaderboardShown || modalOpen;
}

function syncLeaderboardPolling() {
    const shouldPoll = supabaseClient && isLeaderboardUiVisible();
    if (shouldPoll && leaderboardPollInterval === null) {
        leaderboardPollInterval = setInterval(() => {
            refreshLeaderboard();
        }, 3000);
    } else if (!shouldPoll && leaderboardPollInterval !== null) {
        clearInterval(leaderboardPollInterval);
        leaderboardPollInterval = null;
    }
}

function setupLeaderboardLocalSync() {
    window.addEventListener('storage', (event) => {
        if (event.key === LEADERBOARD_KEY || event.key === LEADERBOARD_SYNC_KEY) {
            leaderboardEntries = getLeaderboardFromLocalStorage();
            renderLeaderboard();
        }
    });
    if ('BroadcastChannel' in window) {
        leaderboardSyncChannel = new BroadcastChannel('spaceBattleLeaderboardChannel');
        leaderboardSyncChannel.addEventListener('message', () => {
            leaderboardEntries = getLeaderboardFromLocalStorage();
            renderLeaderboard();
        });
    }
}

function setupLeaderboardRealtime() {
    if (!supabaseClient || leaderboardRealtimeChannel) {
        return;
    }
    leaderboardRealtimeChannel = supabaseClient
        .channel('space-battle-scores')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'scores' },
            () => {
                refreshLeaderboard();
            }
        )
        .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
                console.info('Leaderboard Realtime: connected');
            } else if (status === 'CHANNEL_ERROR') {
                console.warn('Leaderboard Realtime: channel error', err);
            } else if (status === 'TIMED_OUT') {
                console.warn('Leaderboard Realtime: timed out');
            }
        });
}

function addLeaderboardEntryLocal(name, entryScore) {
    const entries = leaderboardEntries.slice();
    const newEntry = { name, score: entryScore };
    entries.push(newEntry);
    entries.sort((a, b) => b.score - a.score);
    const entryIndex = entries.indexOf(newEntry);
    if (entries.length > MAX_LEADERBOARD_ENTRIES) {
        entries.length = MAX_LEADERBOARD_ENTRIES;
    }
    const onLeaderboard = entryIndex >= 0 && entryIndex < entries.length;
    leaderboardEntries = entries;
    saveLeaderboardCache(entries);
    notifyLeaderboardUpdate();
    return onLeaderboard ? entryIndex : -1;
}

async function addLeaderboardEntry(name, entryScore) {
    if (supabaseClient) {
        const { error } = await supabaseClient
            .from('scores')
            .insert({ name, score: entryScore });
        if (error) {
            console.warn('Score insert failed:', error.message);
            return addLeaderboardEntryLocal(name, entryScore);
        }
        await refreshLeaderboard();
        return findLeaderboardHighlightIndex(leaderboardEntries, name, entryScore);
    }
    const index = addLeaderboardEntryLocal(name, entryScore);
    renderLeaderboard();
    return index;
}

function renderLeaderboardTable(tbody, entries, highlightIndex) {
    tbody.innerHTML = '';
    if (entries.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="2">No scores yet</td>';
        tbody.appendChild(row);
        return;
    }
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
        const row = document.createElement('tr');
        if (i === highlightIndex) {
            row.classList.add('leaderboard-entry-current');
        }
        row.innerHTML = `<td>${escapeHtml(entry.name)}</td><td>${medal}${entry.score}</td>`;
        tbody.appendChild(row);
    }
}

function renderLeaderboard() {
    renderLeaderboardTable(el('leaderboardBody'), leaderboardEntries, highlightedLeaderboardIndex);
    renderLeaderboardTable(el('leaderboardModalBody'), leaderboardEntries, highlightedLeaderboardIndex);
}

function openLeaderboardModal() {
    refreshLeaderboard();
    el('leaderboardModal').classList.add('is-open');
    syncLeaderboardPolling();
}

function closeLeaderboardModal() {
    el('leaderboardModal').classList.remove('is-open');
    syncLeaderboardPolling();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Dialogs & UI overlays ---

function closeGameDialog(result) {
    const dialog = el('gameDialog');
    dialog.classList.remove('is-open');
    dialog.removeAttribute('data-dialog-type');
    el('gameDialogInput').style.display = 'none';
    el('gameDialogInput').onkeydown = null;
    el('gameDialogError').style.display = 'none';
    if (dialogResolve) {
        const resolve = dialogResolve;
        dialogResolve = null;
        resolve(result);
    }
}

function showGameDialog({ type, message }) {
    return new Promise((resolve) => {
        dialogResolve = resolve;
        const dialog = el('gameDialog');
        const msgEl = el('gameDialogMessage');
        const input = el('gameDialogInput');
        const error = el('gameDialogError');
        const primary = el('gameDialogPrimary');
        const secondary = el('gameDialogSecondary');
        msgEl.textContent = message;
        error.style.display = 'none';
        error.textContent = '';
        input.value = '';
        input.style.display = type === 'prompt' ? 'block' : 'none';
        secondary.style.display = type === 'alert' ? 'none' : 'inline-block';
        if (type === 'alert') {
            primary.textContent = 'OK';
            primary.onclick = () => closeGameDialog(true);
            secondary.onclick = null;
        } else if (type === 'confirm') {
            primary.textContent = 'Yes';
            secondary.textContent = 'No';
            primary.onclick = () => closeGameDialog(true);
            secondary.onclick = () => closeGameDialog(false);
        } else {
            primary.textContent = 'Submit';
            secondary.textContent = 'Cancel';
            const submitPrompt = () => {
                const value = input.value.trim().slice(0, MAX_NAME_LENGTH);
                if (!value) {
                    error.textContent = 'Name cannot be empty.';
                    error.style.display = 'block';
                    return;
                }
                closeGameDialog(value);
            };
            primary.onclick = submitPrompt;
            secondary.onclick = () => closeGameDialog(null);
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submitPrompt();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeGameDialog(null);
                }
            };
        }
        dialog.setAttribute('data-dialog-type', type);
        dialog.classList.add('is-open');
        if (type === 'prompt') {
            input.focus();
        }
    });
}

async function promptPlayerName() {
    return showGameDialog({
        type: 'prompt',
        message: 'Enter your name (max 50 characters):'
    });
}

async function showAlert(message) {
    await showGameDialog({ type: 'alert', message });
}

async function showScoreRecordedConfirmation(name) {
    await showAlert(
        `Score recorded, ${name}! Only the top ${MAX_LEADERBOARD_ENTRIES} scores are shown on the leaderboard.`
    );
}

async function recordScore() {
    if (scoreRecordedThisSession) {
        await showAlert('Score already recorded for this game.');
        return;
    }
    const name = await promptPlayerName();
    if (name === null) {
        return;
    }
    highlightedLeaderboardIndex = await addLeaderboardEntry(name, score);
    scoreRecordedThisSession = true;
    await showScoreRecordedConfirmation(name);
}

async function handleRestart() {
    if (!scoreRecordedThisSession) {
        const shouldRecord = await showGameDialog({
            type: 'confirm',
            message: 'Record your score before restarting?'
        });
        if (shouldRecord) {
            const name = await promptPlayerName();
            if (name === null) {
                return;
            }
            highlightedLeaderboardIndex = await addLeaderboardEntry(name, score);
            scoreRecordedThisSession = true;
            await showScoreRecordedConfirmation(name);
            return;
        }
    }
    myGameArea.reset();
}

function centerOverlayElement(element, verticalRatio) {
    const canvasOffset = getCanvasOffset();
    element.style.top = (canvasOffset.y + (myGameArea.canvas.height * verticalRatio)) + 'px';
    element.style.left = (canvasOffset.x + (myGameArea.canvas.width / 2)) + 'px';
    element.style.transform = 'translate(-50%, -50%)';
}

function positionLeaderboard() {
    const canvasOffset = getCanvasOffset();
    const leaderboard = el('leaderboard');
    const gameOver = el('gameOver');
    const canvasTop = canvasOffset.y;
    const gameOverCenterY = parseFloat(gameOver.style.top) || (canvasOffset.y + (myGameArea.canvas.height / 2));
    const midpointY = (canvasTop + gameOverCenterY) / 2;
    leaderboard.style.top = midpointY + 'px';
    leaderboard.style.left = (canvasOffset.x + (myGameArea.canvas.width / 2)) + 'px';
    leaderboard.style.transform = 'translate(-50%, -50%)';
}

function centerGameOver() {
    centerOverlayElement(el('gameOver'), 0.5);
}

function positionGameOverActions() {
    centerOverlayElement(el('gameOverActions'), 0.68);
}

function showScore() {
    el('score').textContent = score;
}

function setCanvasUiHidden(hidden) {
    canvasUiHidden = hidden;
    el('gameOver').style.display = hidden ? 'none' : 'block';
    el('leaderboard').style.display = hidden ? 'none' : 'block';
    el('gameOverActions').style.display = hidden ? 'none' : 'flex';
    el('scoreHud').style.display = hidden ? 'none' : 'block';
    const icon = el('uiToggleIcon');
    const button = el('uiToggle');
    icon.className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    button.setAttribute('aria-label', hidden ? 'Show canvas UI' : 'Hide canvas UI');
    button.title = hidden ? 'Show canvas UI' : 'Hide canvas UI';
    if (!hidden) {
        positionLeaderboard();
        positionGameOverActions();
        centerGameOver();
    }
    syncLeaderboardPolling();
}

function toggleCanvasUi() {
    setCanvasUiHidden(!canvasUiHidden);
}

async function initLeaderboard() {
    supabaseClient = initSupabaseClient();
    if (supabaseClient) {
        await refreshLeaderboard();
        setupLeaderboardRealtime();
    } else {
        leaderboardEntries = getLeaderboardFromLocalStorage();
        renderLeaderboard();
        if (!isSupabaseConfigured()) {
            console.info('Supabase not configured — using local leaderboard. Set anonKey in backend/config.js');
        }
    }
    setupLeaderboardLocalSync();
}

// --- Initialization ---

initLeaderboard();
setupMouseOnlyButtons();

window.addEventListener('keydown', moveRocket);
window.addEventListener('keyup', stopRocket);
window.addEventListener('blur', resetMovementState);
