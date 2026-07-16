// Self-contained canvas Dino Run clone. No external art assets — everything is
// drawn procedurally so the whole game is a few KB of code.

const Game = (() => {
  const COLORS = {
    sky1: "#1B1035",
    sky2: "#4A2E6B",
    horizon: "#FF6B35",
    dune: "#3A2255",
    duneFar: "#2A1745",
    ground: "#E8C07D",
    groundLine: "#F5F0E6",
    dino: "#39FF88",
    dinoDark: "#1F8F52",
    monsterBody: "#2A1745",
    monsterBody2: "#432869",
    monsterHorn: "#1A0E2E",
    monsterEye: "#FF6B35",
    monsterEyeGlow: "rgba(255,107,53,0.55)",
    text: "#F5F0E6",
    star: "#F5F0E6",
  };

  // Player sprite (uploaded character), pre-processed to face the direction
  // of travel with a transparent background. Falls back to a drawn silhouette
  // if it hasn't loaded yet.
  const playerImg = new Image();
  let playerImgReady = false;
  playerImg.onload = () => (playerImgReady = true);
  playerImg.src = "assets/player.png";

  const GRAVITY = 0.0055;
  const JUMP_VELOCITY = -1.55;
  const GROUND_Y_RATIO = 0.82;

  let canvas, ctx, width, height, groundY;
  let running = false;
  let animationFrame = null;
  let lastTime = 0;

  let state; // reset() populates this
  let stars = [];
  let dunes = [];

  let callbacks = { onGameOver: () => {}, onScoreUpdate: () => {}, onStart: () => {} };

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = Math.min(rect.width, 900);
    const isMobile = window.innerWidth <= 640;
    height = width * (isMobile ? 0.9 : 0.34);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    groundY = height * GROUND_Y_RATIO;
  }

  function initBackground() {
    stars = Array.from({ length: 40 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height * 0.5,
      r: Math.random() * 1.4 + 0.4,
      twinkle: Math.random() * Math.PI * 2,
    }));
    dunes = Array.from({ length: 6 }, (_, i) => ({
      x: i * 220,
      speedMul: 0.15 + (i % 3) * 0.05,
    }));
  }

  function reset() {
    state = {
      dinoY: 0,
      dinoVY: 0,
      isJumping: false,
      isDucking: false,
      legFrame: 0,
      legTimer: 0,
      stepSquash: 0, // decays each frame; spikes to 1 on each footfall
      dust: [], // footstep dust puffs: { x, y, age, life }
      obstacles: [],
      spawnTimer: 1200,
      speed: 0.32, // px/ms
      distance: 0,
      score: 0,
      groundOffset: 0,
      duneOffset: 0,
      gameOver: false,
      started: false,
    };
  }

  function dinoBox() {
    const w = state.isDucking ? 48 : 30;
    const h = state.isDucking ? 30 : 64;
    const x = 60;
    const y = groundY - h + state.dinoY;
    return { x, y, w, h };
  }

  function jump() {
    if (!state.started || state.gameOver) {
      start();
      return;
    }
    if (!state.isJumping && !state.isDucking) {
      state.isJumping = true;
      state.dinoVY = JUMP_VELOCITY;
      Sound.jump();
    }
  }

  function setDuck(active) {
    if (state.gameOver || !state.started) return;
    if (!state.isJumping) {
      if (active && !state.isDucking) Sound.duck();
      state.isDucking = active;
    }
  }

  function start() {
    reset();
    state.started = true;
    running = true;
    lastTime = performance.now();
    callbacks.onStart();
    animationFrame = requestAnimationFrame(loop);
  }

  function stop(gameOver) {
    running = false;
    if (gameOver) {
      state.gameOver = true;
      Sound.hit();
      callbacks.onGameOver(Math.floor(state.score));
    }
    if (animationFrame) cancelAnimationFrame(animationFrame);
  }

  function spawnObstacle() {
    const roll = Math.random();
    // flyer chance ramps from 0 up to a higher ceiling as score climbs
    const flyerChance = state.score > 150 ? Math.min(0.45, 0.22 + state.score / 60000) : 0;
    if (roll < flyerChance) {
      // flying pterodactyl - must duck
      const flyHigh = Math.random() < 0.5;
      state.obstacles.push({
        type: "flyer",
        x: width + 20,
        w: 34,
        h: 20,
        y: flyHigh ? groundY - 70 : groundY - 30,
        wingFrame: 0,
        wingTimer: 0,
      });
    } else {
      // cluster size keeps growing with score instead of capping at 3
      const maxCluster = Math.min(5, 1 + Math.floor(state.score / 6000));
      const cluster = 1 + Math.floor(Math.random() * maxCluster);
      const spikeW = 20;
      state.obstacles.push({
        type: "ground",
        x: width + 20,
        w: spikeW * cluster + (cluster - 1) * 4,
        h: 30 + Math.min(20, cluster * 5),
        cluster,
        bobSeed: Math.random() * Math.PI * 2,
      });
    }
  }

  function update(dt) {
    // difficulty ramp — same early acceleration as before, but the cap is
    // much higher so a long run keeps getting harder instead of plateauing
    // after a few minutes.
    state.speed = Math.min(1.15, 0.32 + state.distance / 260000);
    state.distance += state.speed * dt;
    state.score += state.speed * dt * 0.12;
    callbacks.onScoreUpdate(Math.floor(state.score));

    // dino physics
    if (state.isJumping) {
      state.dinoVY += GRAVITY * dt;
      state.dinoY += state.dinoVY * dt;
      if (state.dinoY >= 0) {
        state.dinoY = 0;
        state.dinoVY = 0;
        state.isJumping = false;
      }
    }

    // leg animation
    state.legTimer += dt;
    const legInterval = Math.max(70, 140 - state.speed * 100);
    if (state.legTimer > legInterval) {
      state.legTimer = 0;
      state.legFrame = 1 - state.legFrame;
      if (!state.isJumping && !state.isDucking) {
        state.stepSquash = 1;
        Sound.step();
        const box = dinoBox();
        state.dust.push({ x: box.x + box.w * 0.3, y: groundY, age: 0, life: 260 + Math.random() * 80 });
      }
    }
    state.stepSquash = Math.max(0, state.stepSquash - dt / 90);

    // footstep dust puffs
    for (const d of state.dust) {
      d.age += dt;
      d.x -= state.speed * dt * 0.5;
    }
    state.dust = state.dust.filter((d) => d.age < d.life);

    // scrolling
    state.groundOffset = (state.groundOffset + state.speed * dt) % 40;
    state.duneOffset += state.speed * dt * 0.2;

    // spawn
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawnObstacle();
      const base = Math.max(420, 1300 - state.speed * 780);
      state.spawnTimer = base + Math.random() * 500;
    }

    // move obstacles + collision
    const dbox = dinoBox();
    for (const o of state.obstacles) {
      o.x -= state.speed * dt;
      if (o.type === "flyer") {
        o.wingTimer += dt;
        if (o.wingTimer > 180) {
          o.wingTimer = 0;
          o.wingFrame = 1 - o.wingFrame;
        }
      }
      const ox = o.x,
        oy = o.type === "flyer" ? o.y : groundY - o.h,
        ow = o.w,
        oh = o.h;
      const pad = 5;
      if (
        dbox.x + pad < ox + ow - pad &&
        dbox.x + dbox.w - pad > ox + pad &&
        dbox.y + pad < oy + oh - pad &&
        dbox.y + dbox.h - pad > oy + pad
      ) {
        stop(true);
      }
    }
    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -20);
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, groundY);
    g.addColorStop(0, COLORS.sky1);
    g.addColorStop(1, COLORS.sky2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // stars
    ctx.fillStyle = COLORS.star;
    stars.forEach((s) => {
      const alpha = 0.4 + Math.abs(Math.sin(s.twinkle + performance.now() / 900)) * 0.6;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // horizon glow
    const hg = ctx.createLinearGradient(0, groundY - 40, 0, groundY);
    hg.addColorStop(0, "rgba(255,107,53,0)");
    hg.addColorStop(1, "rgba(255,107,53,0.35)");
    ctx.fillStyle = hg;
    ctx.fillRect(0, groundY - 40, width, 40);

    // dunes (parallax silhouettes)
    ctx.fillStyle = COLORS.duneFar;
    drawDuneRow(groundY - 18, 60, state.duneOffset * 0.6);
    ctx.fillStyle = COLORS.dune;
    drawDuneRow(groundY - 10, 46, state.duneOffset);
  }

  function drawDuneRow(baseY, amp, offset) {
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    const step = 90;
    for (let x = -step; x <= width + step; x += step) {
      const px = x - (offset % step);
      const py = baseY - Math.sin((px + offset) * 0.01) * amp * 0.4 - amp * 0.3;
      ctx.lineTo(px, py);
    }
    ctx.lineTo(width, groundY);
    ctx.closePath();
    ctx.fill();
  }

  function drawGround() {
    ctx.strokeStyle = COLORS.groundLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(width, groundY);
    ctx.stroke();

    ctx.fillStyle = COLORS.ground;
    ctx.globalAlpha = 0.7;
    for (let x = -40 + -state.groundOffset; x < width; x += 40) {
      ctx.fillRect(x, groundY + 6, 20, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawDust() {
    for (const d of state.dust) {
      const t = d.age / d.life;
      ctx.globalAlpha = Math.max(0, 0.35 * (1 - t));
      ctx.fillStyle = COLORS.ground;
      const r = 3 + t * 6;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y - t * 6, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawDino() {
    const { x, y, w, h } = dinoBox();
    const cx = x + w / 2;

    // Draw a soft contact shadow under the character regardless of pose.
    ctx.fillStyle = "rgba(13,6,25,0.4)";
    ctx.beginPath();
    ctx.ellipse(cx, groundY + 4, w * 0.55, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    let bob = 0;
    let rot = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (state.isDucking) {
      rot = -0.32; // lean forward into the crouch/slide
      bob = 4;
    } else if (state.isJumping) {
      rot = Math.max(-0.18, Math.min(0.18, -state.dinoVY * 0.06));
    } else {
      rot = Math.sin(performance.now() / 90) * 0.05; // running stride lean
      bob = state.legFrame === 0 ? 1 : -1;
      // quick squash-and-stretch bounce on each footfall, decaying between steps
      scaleY = 1 - state.stepSquash * 0.06;
      scaleX = 1 + state.stepSquash * 0.04;
    }
    ctx.translate(cx, y + h + bob);
    ctx.rotate(rot);
    ctx.scale(scaleX, scaleY);

    if (playerImgReady) {
      ctx.drawImage(playerImg, -w / 2, -h, w, h);
    } else {
      // fallback silhouette while the sprite loads
      ctx.fillStyle = COLORS.dino;
      ctx.fillRect(-w / 2, -h, w, h);
    }
    ctx.restore();
  }

  function drawGoblin(sx, oy, w, h, bobSeed) {
    const bob = Math.sin(performance.now() / 140 + bobSeed) * 1.5;
    const y = oy + bob;
    // body
    ctx.fillStyle = COLORS.monsterBody;
    ctx.beginPath();
    ctx.ellipse(sx + w / 2, y + h * 0.6, w / 2, h * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    // head bump
    ctx.beginPath();
    ctx.ellipse(sx + w / 2, y + h * 0.28, w * 0.38, h * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // horns
    ctx.fillStyle = COLORS.monsterHorn;
    ctx.beginPath();
    ctx.moveTo(sx + w * 0.28, y + h * 0.12);
    ctx.lineTo(sx + w * 0.18, y - h * 0.15);
    ctx.lineTo(sx + w * 0.4, y + h * 0.1);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx + w * 0.72, y + h * 0.12);
    ctx.lineTo(sx + w * 0.82, y - h * 0.15);
    ctx.lineTo(sx + w * 0.6, y + h * 0.1);
    ctx.fill();
    // glowing eyes
    ctx.fillStyle = COLORS.monsterEyeGlow;
    ctx.beginPath();
    ctx.arc(sx + w * 0.36, y + h * 0.3, 5, 0, Math.PI * 2);
    ctx.arc(sx + w * 0.64, y + h * 0.3, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.monsterEye;
    ctx.beginPath();
    ctx.arc(sx + w * 0.36, y + h * 0.3, 2.4, 0, Math.PI * 2);
    ctx.arc(sx + w * 0.64, y + h * 0.3, 2.4, 0, Math.PI * 2);
    ctx.fill();
    // claw feet
    ctx.fillStyle = COLORS.monsterHorn;
    ctx.fillRect(sx + w * 0.22, y + h - 3, w * 0.16, 5);
    ctx.fillRect(sx + w * 0.62, y + h - 3, w * 0.16, 5);
  }

  function drawObstacles() {
    for (const o of state.obstacles) {
      if (o.type === "ground") {
        const oy = groundY - o.h;
        const spikeW = 20;
        for (let i = 0; i < o.cluster; i++) {
          const sx = o.x + i * (spikeW + 4);
          drawGoblin(sx, oy, spikeW, o.h, o.bobSeed + i * 1.3);
        }
      } else {
        // wraith bat: dark body with flapping membrane wings + glowing eyes
        const cx = o.x + o.w * 0.5;
        const cy = o.y + o.h * 0.5;
        const wingUp = o.wingFrame === 0;
        ctx.fillStyle = COLORS.monsterBody2;
        // wings
        ctx.beginPath();
        ctx.moveTo(cx - o.w * 0.1, cy);
        ctx.lineTo(cx - o.w * 0.65, cy + (wingUp ? -o.h * 0.5 : o.h * 0.35));
        ctx.lineTo(cx - o.w * 0.2, cy + o.h * 0.15);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + o.w * 0.1, cy);
        ctx.lineTo(cx + o.w * 0.65, cy + (wingUp ? -o.h * 0.5 : o.h * 0.35));
        ctx.lineTo(cx + o.w * 0.2, cy + o.h * 0.15);
        ctx.fill();
        // body
        ctx.fillStyle = COLORS.monsterBody;
        ctx.beginPath();
        ctx.ellipse(cx, cy, o.w * 0.22, o.h * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        // glowing eyes
        ctx.fillStyle = COLORS.monsterEye;
        ctx.beginPath();
        ctx.arc(cx - 4, cy - 2, 2.2, 0, Math.PI * 2);
        ctx.arc(cx + 4, cy - 2, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGameOver() {
    ctx.fillStyle = "rgba(27,16,53,0.55)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.font = "bold 22px 'Space Grotesk', sans-serif";
    ctx.fillText("HOODIE DOWN", width / 2, height / 2 - 10);
    ctx.font = "14px 'Space Grotesk', sans-serif";
    ctx.fillText("Tap / Space to try again", width / 2, height / 2 + 16);
  }

  function drawIdle() {
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.font = "bold 18px 'Space Grotesk', sans-serif";
    ctx.fillText("Tap or press Space to hold the line", width / 2, height / 2);
  }

  function render() {
    drawBackground();
    drawGround();
    drawDust();
    drawObstacles();
    drawDino();
    if (!state.started) drawIdle();
    if (state.gameOver) drawGameOver();
  }

  function loop(time) {
    const dt = Math.min(40, time - lastTime);
    lastTime = time;
    if (running) {
      update(dt);
    }
    render();
    if (running) animationFrame = requestAnimationFrame(loop);
  }

  function init(canvasEl, cbs) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    callbacks = { ...callbacks, ...cbs };
    resize();
    initBackground();
    reset();
    render();
    window.addEventListener("resize", () => {
      resize();
      initBackground();
      render();
    });

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        jump();
      } else if (e.code === "ArrowDown") {
        setDuck(true);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "ArrowDown") setDuck(false);
    });

    // Touch/pointer gesture: a quick tap jumps; dragging down from the
    // touch start point ducks (released on lift). Works for mouse too,
    // since pointer events unify both — but on mobile this replaces the
    // need for a separate on-screen duck button entirely.
    const DUCK_DRAG_THRESHOLD = 24; // px of downward movement before it counts as a duck
    let touchStartY = null;
    let touchIsDucking = false;
    let touchMoved = false;

    canvas.addEventListener("pointerdown", (e) => {
      touchStartY = e.clientY;
      touchMoved = false;
      touchIsDucking = false;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (touchStartY === null || touchIsDucking || !running) return;
      if (e.clientY - touchStartY > DUCK_DRAG_THRESHOLD) {
        touchIsDucking = true;
        touchMoved = true;
        setDuck(true);
      }
    });

    function endTouch() {
      if (touchIsDucking) {
        setDuck(false);
      } else if (touchStartY !== null && !touchMoved) {
        jump();
      }
      touchStartY = null;
      touchIsDucking = false;
      touchMoved = false;
    }
    canvas.addEventListener("pointerup", endTouch);
    canvas.addEventListener("pointercancel", endTouch);
  }

  return { init, jump, setDuck, get isRunning() { return running; } };
})();