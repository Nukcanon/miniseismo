(() => {
  "use strict";

  const STORAGE_KEY = "miniseismo.settings.v1";
  const HISTORY_WINDOW_MS = 1000;
  const CHART_WINDOW_SEC = 10;
  const UI_INTERVAL_MS = 50;
  const HIGH_PASS_ALPHA = 0.8;

  const DEFAULT_SETTINGS = Object.freeze({
    hideXAxis: true,
    accelXMin: 2,
    accelXMax: 5,
    accelYMin: 2,
    accelYMax: 5,
    ampXMin: 1,
    ampXMax: 3,
    ampYMin: 1,
    ampYMax: 3,
    timeInRangeOnly: false,
    targetTime: 10,
    feedbackDuration: 2,
    soundOn: true,
    completionSoundOn: true
  });

  const SETTING_IDS = Object.keys(DEFAULT_SETTINGS);

  const dom = {
    startStopButton: document.querySelector("#startStopButton"),
    resetButton: document.querySelector("#resetButton"),
    settingsButton: document.querySelector("#settingsButton"),
    sensorStatus: document.querySelector("#sensorStatus"),
    sensorStatusText: document.querySelector("#sensorStatusText"),
    timer: document.querySelector("#timer"),
    timerPanel: document.querySelector(".timer-panel"),
    timerMode: document.querySelector("#timerMode"),
    feedbackX: document.querySelector("#feedbackX"),
    feedbackY: document.querySelector("#feedbackY"),
    valueAccelX: document.querySelector("#valueAccelX"),
    valueAccelY: document.querySelector("#valueAccelY"),
    valueAmpX: document.querySelector("#valueAmpX"),
    valueAmpY: document.querySelector("#valueAmpY"),
    xAxisSection: document.querySelector("#xAxisSection"),
    notice: document.querySelector("#notice"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsForm: document.querySelector("#settingsForm"),
    settingsError: document.querySelector("#settingsError"),
    closeSettingsButton: document.querySelector("#closeSettingsButton"),
    cancelSettingsButton: document.querySelector("#cancelSettingsButton"),
    hideXAxis: document.querySelector("#hideXAxis"),
    xSettingsGroup: document.querySelector("#xSettingsGroup")
  };

  const settingsInputs = Object.fromEntries(
    SETTING_IDS.map((key) => [key, document.getElementById(key)])
  );

  const state = {
    settings: loadSettings(),
    measuring: false,
    listenerAttached: false,
    sensorSeen: false,
    sensorFallback: false,
    lastSensorTime: 0,
    measurementTime: 0,
    velocity: [0, 0],
    position: [0, 0],
    gravity: [0, 0],
    histories: {
      accelX: [], accelY: [], ampX: [], ampY: []
    },
    elapsedMs: 0,
    timerTriggered: false,
    timerFinished: false,
    lastTimerUpdate: 0,
    lastFeedbackUpdate: { x: 0, y: 0 },
    lastErrorSound: 0,
    uiTimer: null,
    sensorWatchdog: null,
    audioContext: null
  };

  class TraceChart {
    constructor(canvas, color) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.color = color;
      this.data = [];
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas);
    }

    add(time, value) {
      if (!Number.isFinite(value)) return;
      this.data.push({ time, value });
      const cutoff = time - CHART_WINDOW_SEC;
      while (this.data.length && this.data[0].time < cutoff) this.data.shift();
      this.draw();
    }

    clear() {
      this.data = [];
      this.draw();
    }

    draw() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const pad = { left: 35, right: 7, top: 7, bottom: 20 };
      const plotW = Math.max(1, rect.width - pad.left - pad.right);
      const plotH = Math.max(1, rect.height - pad.top - pad.bottom);
      const latest = this.data.length ? this.data[this.data.length - 1].time : 0;
      const start = Math.max(0, latest - CHART_WINDOW_SEC);
      const values = this.data.map((point) => point.value);
      let maxY = Math.max(1, ...values);
      let minY = 0;
      if (values.length) {
        maxY = Math.max(0.25, Math.max(...values) * 1.18);
      }

      ctx.strokeStyle = "#dce5ef";
      ctx.fillStyle = "#94a3b8";
      ctx.lineWidth = 1;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      for (let i = 0; i <= 3; i += 1) {
        const ratio = i / 3;
        const y = pad.top + plotH * ratio;
        const label = maxY - (maxY - minY) * ratio;
        ctx.beginPath();
        ctx.moveTo(pad.left, Math.round(y) + .5);
        ctx.lineTo(pad.left + plotW, Math.round(y) + .5);
        ctx.stroke();
        ctx.fillText(label.toFixed(label >= 10 ? 0 : 1), pad.left - 5, y);
      }

      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      for (let i = 0; i <= 2; i += 1) {
        const x = pad.left + plotW * (i / 2);
        const secondsAgo = Math.round(CHART_WINDOW_SEC * (1 - i / 2));
        ctx.fillText(secondsAgo === 0 ? "현재" : `-${secondsAgo}초`, x, pad.top + plotH + 6);
      }

      if (this.data.length < 2) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("측정 대기", pad.left + plotW / 2, pad.top + plotH / 2);
        return;
      }

      ctx.beginPath();
      this.data.forEach((point, index) => {
        const x = pad.left + ((point.time - start) / CHART_WINDOW_SEC) * plotW;
        const yRatio = (point.value - minY) / (maxY - minY || 1);
        const y = pad.top + plotH - yRatio * plotH;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  const charts = {
    accelX: new TraceChart(document.querySelector("#chartAccelX"), "#0284c7"),
    ampX: new TraceChart(document.querySelector("#chartAmpX"), "#7c3aed"),
    accelY: new TraceChart(document.querySelector("#chartAccelY"), "#15803d"),
    ampY: new TraceChart(document.querySelector("#chartAmpY"), "#ea580c")
  };

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(parsed || {}) });
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function sanitizeSettings(candidate) {
    const cleaned = { ...DEFAULT_SETTINGS };
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof defaultValue === "boolean") cleaned[key] = Boolean(candidate[key]);
      else {
        const number = Number(candidate[key]);
        cleaned[key] = Number.isFinite(number) && number >= 0 ? number : defaultValue;
      }
    }
    return cleaned;
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }

  function setStatus(text, status = "idle") {
    dom.sensorStatus.dataset.state = status;
    dom.sensorStatusText.textContent = text;
  }

  function showNotice(message) {
    dom.notice.textContent = message;
    dom.notice.hidden = !message;
  }

  function formatValue(value) {
    return Number.isFinite(value) ? Math.abs(value).toFixed(2) : "0.00";
  }

  function trimHistory(history, cutoff) {
    let count = 0;
    while (count < history.length && history[count].timestamp < cutoff) count += 1;
    if (count) history.splice(0, count);
  }

  function averageAbsolute(history) {
    if (!history.length) return 0;
    return history.reduce((sum, point) => sum + Math.abs(point.value), 0) / history.length;
  }

  function currentAverages() {
    const cutoff = performance.now() - HISTORY_WINDOW_MS;
    Object.values(state.histories).forEach((history) => trimHistory(history, cutoff));
    return {
      accelX: averageAbsolute(state.histories.accelX),
      accelY: averageAbsolute(state.histories.accelY),
      ampX: averageAbsolute(state.histories.ampX),
      ampY: averageAbsolute(state.histories.ampY)
    };
  }

  function rangeState(value, min, max) {
    if (value > max) return "high";
    if (value < min) return "low";
    return "ok";
  }

  function axisFeedback(axis, accel, amp) {
    const lower = axis.toLowerCase();
    const accelState = rangeState(accel, state.settings[`accel${axis}Min`], state.settings[`accel${axis}Max`]);
    const ampState = rangeState(amp, state.settings[`amp${axis}Min`], state.settings[`amp${axis}Max`]);
    const messages = [];
    if (accelState === "low") messages.push(`${axis} 가속도 더 강하게`);
    if (accelState === "high") messages.push(`${axis} 가속도 더 약하게`);
    if (ampState === "low") messages.push(`${axis} 진폭 더 크게`);
    if (ampState === "high") messages.push(`${axis} 진폭 더 작게`);
    return {
      ok: messages.length === 0,
      state: accelState === "high" || ampState === "high" ? "high" : (accelState === "low" || ampState === "low" ? "low" : "ok"),
      message: messages.length ? messages.join("\n") : "OK",
      key: lower
    };
  }

  function isShakingOk(values) {
    if (!state.histories.accelY.length) return false;
    const xOk = values.accelX >= state.settings.accelXMin && values.accelX <= state.settings.accelXMax &&
      values.ampX >= state.settings.ampXMin && values.ampX <= state.settings.ampXMax;
    const yOk = values.accelY >= state.settings.accelYMin && values.accelY <= state.settings.accelYMax &&
      values.ampY >= state.settings.ampYMin && values.ampY <= state.settings.ampYMax;
    return state.settings.hideXAxis ? yOk : xOk && yOk;
  }

  function renderFeedback(element, feedback, now) {
    const holdMs = state.settings.feedbackDuration * 1000;
    if (!feedback.ok && now <= state.lastFeedbackUpdate[feedback.key] + holdMs) return false;
    if (!feedback.ok) state.lastFeedbackUpdate[feedback.key] = now;
    element.className = `feedback-card is-${feedback.state}`;
    element.querySelector(".feedback-message").textContent = feedback.message;
    return !feedback.ok;
  }

  function updateTimer(now, values) {
    if (state.timerTriggered && !state.timerFinished) {
      const delta = Math.min(Math.max(now - state.lastTimerUpdate, 0), 250);
      if (!state.settings.timeInRangeOnly || isShakingOk(values)) state.elapsedMs += delta;
      const targetMs = state.settings.targetTime * 1000;
      if (targetMs > 0 && state.elapsedMs >= targetMs) {
        state.elapsedMs = targetMs;
        state.timerFinished = true;
        dom.timerPanel.classList.add("is-complete");
        dom.timerMode.textContent = "목표 시간 완료";
        if (state.settings.completionSoundOn) playCompletionSound();
      }
      state.lastTimerUpdate = now;
    }
    const seconds = Math.floor(state.elapsedMs / 1000);
    const hundredths = Math.floor((state.elapsedMs % 1000) / 10);
    dom.timer.value = `${seconds}.${String(hundredths).padStart(2, "0")}`;
    dom.timer.textContent = dom.timer.value;
  }

  function updateUi() {
    if (!state.measuring) return;
    const now = performance.now();
    const values = currentAverages();
    // 원본 안드로이드 앱처럼 초기 센서값이 충분히 쌓인 뒤 판정합니다.
    if (state.histories.accelY.length < 10) return;
    updateTimer(now, values);

    dom.valueAccelX.textContent = formatValue(values.accelX);
    dom.valueAccelY.textContent = formatValue(values.accelY);
    dom.valueAmpX.textContent = formatValue(values.ampX);
    dom.valueAmpY.textContent = formatValue(values.ampY);

    const feedbackX = axisFeedback("X", values.accelX, values.ampX);
    const feedbackY = axisFeedback("Y", values.accelY, values.ampY);
    let needsErrorSound = false;
    if (!state.settings.hideXAxis) needsErrorSound = renderFeedback(dom.feedbackX, feedbackX, now) || needsErrorSound;
    needsErrorSound = renderFeedback(dom.feedbackY, feedbackY, now) || needsErrorSound;
    if (needsErrorSound && now > state.lastErrorSound + 1000 && state.settings.soundOn) {
      playTone(880, .11, .055);
      state.lastErrorSound = now;
    }

    if (state.sensorSeen) {
      charts.accelX.add(state.measurementTime, values.accelX);
      charts.ampX.add(state.measurementTime, values.ampX);
      charts.accelY.add(state.measurementTime, values.accelY);
      charts.ampY.add(state.measurementTime, values.ampY);
    }
  }

  function onDeviceMotion(event) {
    if (!state.measuring) return;
    const source = event.acceleration;
    const withGravity = event.accelerationIncludingGravity;
    let ax;
    let ay;

    if (source && Number.isFinite(source.x) && Number.isFinite(source.y)) {
      ax = source.x;
      ay = source.y;
      state.sensorFallback = false;
    } else if (withGravity && Number.isFinite(withGravity.x) && Number.isFinite(withGravity.y)) {
      const gravityAlpha = 0.8;
      state.gravity[0] = gravityAlpha * state.gravity[0] + (1 - gravityAlpha) * withGravity.x;
      state.gravity[1] = gravityAlpha * state.gravity[1] + (1 - gravityAlpha) * withGravity.y;
      ax = withGravity.x - state.gravity[0];
      ay = withGravity.y - state.gravity[1];
      state.sensorFallback = true;
    } else {
      return;
    }

    const now = performance.now();
    if (!state.sensorSeen) {
      state.sensorSeen = true;
      state.lastSensorTime = now;
      setStatus(state.sensorFallback ? "센서 연결 · 보정 중" : "센서 연결됨", "active");
      return;
    }

    const intervalSeconds = Number.isFinite(event.interval) && event.interval > 0
      ? event.interval / 1000
      : (now - state.lastSensorTime) / 1000;
    const dt = Math.min(Math.max(intervalSeconds, .001), .1);
    state.lastSensorTime = now;
    state.measurementTime += dt;

    state.velocity[0] = HIGH_PASS_ALPHA * (state.velocity[0] + ax * dt);
    state.velocity[1] = HIGH_PASS_ALPHA * (state.velocity[1] + ay * dt);
    state.position[0] = HIGH_PASS_ALPHA * (state.position[0] + state.velocity[0] * dt * 100);
    state.position[1] = HIGH_PASS_ALPHA * (state.position[1] + state.velocity[1] * dt * 100);

    state.histories.accelX.push({ value: ax, timestamp: now });
    state.histories.accelY.push({ value: ay, timestamp: now });
    state.histories.ampX.push({ value: state.position[0], timestamp: now });
    state.histories.ampY.push({ value: state.position[1], timestamp: now });

    if (!state.timerTriggered) {
      const trigger = state.settings.hideXAxis
        ? Math.abs(ay) > state.settings.accelYMin
        : Math.abs(ax) > state.settings.accelXMin || Math.abs(ay) > state.settings.accelYMin;
      if (trigger) {
        state.timerTriggered = true;
        state.lastTimerUpdate = now;
        dom.timerMode.textContent = state.settings.timeInRangeOnly ? "적정 범위에서만 측정 중" : "측정 중";
      }
    }
  }

  function attachSensor() {
    if (state.listenerAttached) return;
    window.addEventListener("devicemotion", onDeviceMotion, { passive: true });
    state.listenerAttached = true;
  }

  function detachSensor() {
    if (!state.listenerAttached) return;
    window.removeEventListener("devicemotion", onDeviceMotion);
    state.listenerAttached = false;
  }

  async function requestSensorAccess() {
    if (!("DeviceMotionEvent" in window)) throw new Error("이 브라우저는 동작 센서를 지원하지 않습니다.");
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== "granted") throw new Error("동작 센서 권한이 허용되지 않았습니다. 브라우저 설정에서 권한을 허용해주세요.");
    }
    attachSensor();
  }

  function startWatchdog() {
    clearTimeout(state.sensorWatchdog);
    state.sensorWatchdog = setTimeout(() => {
      if (state.measuring && !state.sensorSeen) {
        setStatus("센서 신호 없음", "error");
        showNotice("센서값을 받지 못했습니다. 스마트폰의 Chrome 또는 Safari에서 HTTPS 주소로 접속했는지 확인해주세요.");
      }
    }, 2500);
  }

  async function startMeasurement() {
    if (!window.isSecureContext) {
      showNotice("센서 사용에는 HTTPS 접속이 필요합니다. GitHub Pages 주소(https://…)에서 열어주세요.");
      setStatus("HTTPS 필요", "error");
      return;
    }
    try {
      // iOS 센서 권한과 오디오 활성화 모두 버튼 클릭 시점의 사용자 동작이 필요합니다.
      const audioReady = ensureAudioContext();
      await requestSensorAccess();
      await audioReady;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "센서 권한을 사용할 수 없습니다.");
      setStatus("센서 사용 불가", "error");
      return;
    }

    state.measuring = true;
    state.sensorSeen = false;
    state.lastSensorTime = 0;
    state.gravity = [0, 0];
    state.histories = { accelX: [], accelY: [], ampX: [], ampY: [] };
    state.timerTriggered = false;
    state.timerFinished = false;
    state.lastTimerUpdate = performance.now();
    dom.timerPanel.classList.remove("is-complete");
    dom.timerMode.textContent = "흔들림 감지 대기";
    dom.startStopButton.classList.add("is-stop");
    dom.startStopButton.querySelector("span").textContent = "측정 정지";
    dom.startStopButton.querySelector("svg").innerHTML = '<path d="M7 7h10v10H7z"/>';
    dom.settingsButton.disabled = true;
    showNotice("");
    setStatus("센서 연결 중", "idle");
    state.uiTimer = window.setInterval(updateUi, UI_INTERVAL_MS);
    startWatchdog();
  }

  function stopMeasurement() {
    state.measuring = false;
    detachSensor();
    clearInterval(state.uiTimer);
    clearTimeout(state.sensorWatchdog);
    state.uiTimer = null;
    dom.startStopButton.classList.remove("is-stop");
    dom.startStopButton.querySelector("span").textContent = "측정 시작";
    dom.startStopButton.querySelector("svg").innerHTML = '<path d="m8 5 11 7-11 7V5Z"/>';
    dom.settingsButton.disabled = false;
    setStatus("측정 정지", "idle");
    setFeedbackIdle("측정 정지");
  }

  function resetAll() {
    state.measurementTime = 0;
    state.velocity = [0, 0];
    state.position = [0, 0];
    state.gravity = [0, 0];
    state.histories = { accelX: [], accelY: [], ampX: [], ampY: [] };
    state.elapsedMs = 0;
    state.timerTriggered = false;
    state.timerFinished = false;
    state.lastFeedbackUpdate = { x: 0, y: 0 };
    dom.timer.value = "0.00";
    dom.timer.textContent = "0.00";
    dom.timerPanel.classList.remove("is-complete");
    dom.timerMode.textContent = state.measuring ? "흔들림 감지 대기" : "흔들림 감지 후 시작";
    [dom.valueAccelX, dom.valueAccelY, dom.valueAmpX, dom.valueAmpY].forEach((item) => { item.textContent = "0.00"; });
    Object.values(charts).forEach((chart) => chart.clear());
    setFeedbackIdle(state.measuring ? "측정 중" : "대기 중");
  }

  function setFeedbackIdle(message) {
    [dom.feedbackX, dom.feedbackY].forEach((element) => {
      element.className = "feedback-card is-idle";
      element.querySelector(".feedback-message").textContent = message;
    });
  }

  async function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!state.audioContext) state.audioContext = new AudioContextClass();
    if (state.audioContext.state === "suspended") await state.audioContext.resume();
  }

  function playTone(frequency, duration, volume = .06, delay = 0) {
    if (!state.audioContext) return;
    const context = state.audioContext;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + .02);
  }

  function playCompletionSound() {
    playTone(1046, .13, .07);
    playTone(1318, .16, .07, .17);
  }

  function applySettingsToUi() {
    dom.xAxisSection.hidden = state.settings.hideXAxis;
    dom.feedbackX.hidden = state.settings.hideXAxis;
    dom.feedbackX.parentElement.classList.toggle("is-x-hidden", state.settings.hideXAxis);
    dom.timerMode.textContent = state.settings.timeInRangeOnly ? "적정 범위에서만 시간 측정" : "흔들림 감지 후 시작";
    requestAnimationFrame(() => Object.values(charts).forEach((chart) => chart.draw()));
  }

  function populateSettingsForm() {
    for (const [key, value] of Object.entries(state.settings)) {
      const input = settingsInputs[key];
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value;
      else input.value = String(value);
    }
    updateXSettingsDisabled();
    dom.settingsError.hidden = true;
  }

  function updateXSettingsDisabled() {
    const disabled = dom.hideXAxis.checked;
    ["accelXMin", "accelXMax", "ampXMin", "ampXMax"].forEach((id) => { settingsInputs[id].disabled = disabled; });
    dom.xSettingsGroup.classList.toggle("is-disabled", disabled);
  }

  function readSettingsForm() {
    const candidate = {};
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      const input = settingsInputs[key];
      candidate[key] = typeof defaultValue === "boolean" ? input.checked : Number(input.value);
    }
    return candidate;
  }

  function validateSettings(candidate) {
    const numericKeys = SETTING_IDS.filter((key) => typeof DEFAULT_SETTINGS[key] === "number");
    if (numericKeys.some((key) => !Number.isFinite(candidate[key]) || candidate[key] < 0)) {
      return "모든 수치는 0 이상의 숫자로 입력해주세요.";
    }
    const pairs = [
      ["accelXMin", "accelXMax", "X축 가속도"],
      ["ampXMin", "ampXMax", "X축 진폭"],
      ["accelYMin", "accelYMax", "Y축 가속도"],
      ["ampYMin", "ampYMax", "Y축 진폭"]
    ];
    const invalid = pairs.find(([min, max]) => candidate[min] > candidate[max]);
    return invalid ? `${invalid[2]}의 최소값은 최대값보다 클 수 없습니다.` : "";
  }

  function openSettings() {
    populateSettingsForm();
    dom.settingsDialog.showModal();
  }

  function closeSettings() {
    dom.settingsDialog.close();
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const report = (error) => console.warn("WebMCP tool registration failed", error);
    try {
      Promise.resolve(context.registerTool({
        name: "read_miniseismo_settings",
        title: "MiniSeismo 설정 읽기",
        description: "현재 MiniSeismo 측정 설정을 읽습니다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() { return { ...state.settings }; }
      })).catch(report);

      Promise.resolve(context.registerTool({
        name: "configure_miniseismo",
        title: "MiniSeismo 설정 변경",
        description: "가속도·진폭 범위와 타이머 및 소리 설정을 한 번에 변경합니다. 제공하지 않은 값은 유지합니다.",
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, typeof value === "boolean" ? { type: "boolean" } : { type: "number", minimum: 0 }])),
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (state.measuring) throw new Error("측정 중에는 설정을 변경할 수 없습니다.");
          const candidate = { ...state.settings, ...(input || {}) };
          const error = validateSettings(candidate);
          if (error) throw new Error(error);
          state.settings = sanitizeSettings(candidate);
          saveSettings();
          applySettingsToUi();
          return { saved: true, settings: { ...state.settings } };
        }
      })).catch(report);
    } catch (error) {
      report(error);
    }
  }

  dom.startStopButton.addEventListener("click", () => {
    if (state.measuring) stopMeasurement();
    else void startMeasurement();
  });
  dom.resetButton.addEventListener("click", resetAll);
  dom.settingsButton.addEventListener("click", openSettings);
  dom.closeSettingsButton.addEventListener("click", closeSettings);
  dom.cancelSettingsButton.addEventListener("click", closeSettings);
  dom.hideXAxis.addEventListener("change", updateXSettingsDisabled);
  dom.settingsDialog.addEventListener("click", (event) => {
    if (event.target === dom.settingsDialog) closeSettings();
  });
  dom.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const candidate = readSettingsForm();
    const error = validateSettings(candidate);
    if (error) {
      dom.settingsError.textContent = error;
      dom.settingsError.hidden = false;
      return;
    }
    state.settings = sanitizeSettings(candidate);
    saveSettings();
    applySettingsToUi();
    closeSettings();
  });

  document.addEventListener("visibilitychange", () => {
    if (!state.measuring) return;
    if (document.hidden) {
      detachSensor();
      clearInterval(state.uiTimer);
    } else {
      state.lastSensorTime = 0;
      state.lastTimerUpdate = performance.now();
      attachSensor();
      clearInterval(state.uiTimer);
      state.uiTimer = window.setInterval(updateUi, UI_INTERVAL_MS);
    }
  });

  window.addEventListener("pagehide", () => {
    detachSensor();
    clearInterval(state.uiTimer);
  });

  applySettingsToUi();
  Object.values(charts).forEach((chart) => chart.draw());
  registerWebMcpTools();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
  }
})();
