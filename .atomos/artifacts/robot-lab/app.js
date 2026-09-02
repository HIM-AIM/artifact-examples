const initialState = () => ({
  robot_id: "R-03",
  x: 1,
  y: 0,
  battery: 92,
  stage: "ready",
  progress: 0,
  busy: false,
  carrying: false,
  sample_loaded: false,
  events: [{ time: now(), message: "Robot R-03 已连接" }],
});

const runtime = { robot: null, generation: 0, timers: [], disposeOperations: null };
const els = {
  robot: document.querySelector("#robot"),
  robotSample: document.querySelector("#robotSample"),
  deviceSample: document.querySelector("#deviceSample"),
  deviceDoor: document.querySelector(".device-door"),
  deviceScreen: document.querySelector("#deviceScreen"),
  status: document.querySelector("#statusText"),
  mode: document.querySelector("#modeLabel"),
  robotMode: document.querySelector("#robotMode"),
  battery: document.querySelector("#battery"),
  payload: document.querySelector("#payload"),
  position: document.querySelector("#positionLabel"),
  step: document.querySelector("#sceneStep"),
  detail: document.querySelector("#sceneDetail"),
  run: document.querySelector("#runScenario"),
  log: document.querySelector("#eventLog"),
  error: document.querySelector("#controlError"),
  sdkStatus: document.querySelector("#sdkStatus"),
};

function now() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function snapshot() {
  return JSON.parse(JSON.stringify(runtime.robot));
}

function event(message) {
  runtime.robot.events.push({ time: now(), message });
  runtime.robot.events = runtime.robot.events.slice(-20);
}

function stageCopy(stage) {
  return {
    ready: ["等待任务", "Robot 已连接，可以接受指令"],
    moving_to_sample: ["前往样品台", "正在定位 ST-01"],
    picking: ["夹取样品", "样品 S-2408 身份校验通过"],
    moving_to_device: ["运送样品", "前往离心机 CF-02"],
    loading: ["放入设备", "舱门已打开，正在装载"],
    complete: ["任务完成", "样品已放入离心机 CF-02"],
    manual: ["手动移动", "已响应移动指令"],
    stopped: ["已停止", "Robot 保持当前位置"],
  }[stage] || ["状态同步", stage];
}

function render() {
  const data = runtime.robot;
  els.robot.style.setProperty("--x", `${8 + (data.x / 10) * 78}%`);
  els.robot.style.setProperty("--y", `${90 - (data.y / 10) * 73}%`);
  els.robot.classList.toggle("is-working", ["picking", "loading"].includes(data.stage));
  els.robotSample.classList.toggle("visible", data.carrying);
  els.deviceSample.classList.toggle("visible", data.sample_loaded);
  els.deviceDoor.classList.toggle("loading", data.stage === "loading");
  els.deviceScreen.textContent = data.sample_loaded ? "LOADED" : data.stage === "loading" ? "OPEN" : "READY";
  els.position.textContent = `X ${data.x} · Y ${data.y}`;
  els.status.textContent = data.busy ? "RUNNING" : data.stage === "complete" ? "COMPLETE" : data.stage === "stopped" ? "STOPPED" : "READY";
  els.mode.textContent = data.busy ? "自动" : data.stage === "manual" ? "手动" : "待机";
  els.robotMode.textContent = data.busy ? "AUTO RUN" : data.stage === "manual" ? "MANUAL" : "STANDBY";
  els.battery.textContent = `${data.battery}%`;
  els.payload.textContent = data.carrying ? "S-2408" : "空载";
  const copy = stageCopy(data.stage);
  els.step.textContent = copy[0];
  els.detail.textContent = `${copy[1]} · 位置 (${data.x}, ${data.y})`;
  els.run.disabled = data.busy;
  document.querySelectorAll("[data-direction]").forEach((button) => { button.disabled = data.busy; });
  els.log.replaceChildren();
  const events = data.events.slice(-5).reverse();
  if (!events.length) {
    const item = document.createElement("li");
    item.textContent = "暂无运行记录";
    els.log.append(item);
  }
  events.forEach((entry) => {
    const item = document.createElement("li");
    const time = document.createElement("time");
    item.textContent = entry.message;
    time.textContent = entry.time;
    item.append(time);
    els.log.append(item);
  });
}

function fail(message) {
  els.error.textContent = message;
  window.setTimeout(() => { if (els.error.textContent === message) els.error.textContent = ""; }, 3500);
}

function cancelScenario() {
  runtime.generation += 1;
  runtime.timers.forEach(window.clearTimeout);
  runtime.timers = [];
}

function moveRobot(direction, units) {
  if (!["up", "down", "left", "right"].includes(direction)) throw new Error("direction 必须是 up、down、left 或 right");
  if (!Number.isInteger(units) || units < 1 || units > 9) throw new Error("units 必须是 1 到 9 的整数");
  if (runtime.robot.busy) throw new Error("Robot 正在执行自动任务，请先停止");
  const dx = direction === "right" ? units : direction === "left" ? -units : 0;
  const dy = direction === "up" ? units : direction === "down" ? -units : 0;
  runtime.robot.x = Math.max(0, Math.min(10, runtime.robot.x + dx));
  runtime.robot.y = Math.max(0, Math.min(10, runtime.robot.y + dy));
  Object.assign(runtime.robot, { stage: "manual", progress: 0, sample_loaded: false });
  event(`控制指令：${{ up: "向上", down: "向下", left: "向左", right: "向右" }[direction]}移动 ${units} 个单位`);
  render();
  return snapshot();
}

function startSampleTransfer(input = {}) {
  if (runtime.robot.busy) throw new Error("Robot 正在执行任务");
  if ((input.action || "load_sample") !== "load_sample") throw new Error("当前仅支持 load_sample 场景");
  if ((input.sample_id || "S-2408") !== "S-2408") throw new Error("当前仅支持样品 S-2408");
  if ((input.device_id || "CF-02") !== "CF-02") throw new Error("当前仅支持离心机 CF-02");
  cancelScenario();
  const generation = runtime.generation;
  Object.assign(runtime.robot, { x: 1, y: 0, busy: true, stage: "moving_to_sample", progress: 6, carrying: false, sample_loaded: false });
  event("任务已创建：S-2408 → CF-02");
  render();
  const steps = [
    [1150, "沿 X 轴到达 X=2", { x: 2, stage: "moving_to_sample", progress: 15 }],
    [2300, "沿 Y 轴到达样品台 ST-01", { y: 3, stage: "picking", progress: 28 }],
    [3400, "夹取样品 S-2408", { carrying: true, stage: "moving_to_device", progress: 43 }],
    [4700, "沿 Y 轴进入北侧避障通道", { y: 8, stage: "moving_to_device", progress: 57 }],
    [6000, "沿 X 轴绕过实验岛 B", { x: 8, stage: "moving_to_device", progress: 72 }],
    [7150, "沿 Y 轴到达离心机 CF-02", { y: 7, stage: "loading", progress: 82 }],
    [8400, "样品 S-2408 已放入 CF-02", { carrying: false, sample_loaded: true, progress: 94 }],
    [9200, "自动转运任务完成", { busy: false, stage: "complete", progress: 100, battery: 91 }],
  ];
  runtime.timers = steps.map(([delay, message, changes]) => window.setTimeout(() => {
    if (runtime.generation !== generation || !runtime.robot.busy) return;
    Object.assign(runtime.robot, changes);
    event(message);
    render();
  }, delay));
  return snapshot();
}

function stopRobot() {
  cancelScenario();
  Object.assign(runtime.robot, { busy: false, stage: "stopped" });
  event("Robot 已停止，当前位置已锁定");
  render();
  return snapshot();
}

function resetRobot() {
  cancelScenario();
  runtime.robot = initialState();
  runtime.robot.events = [{ time: now(), message: "Robot 已重置至充电位" }];
  render();
  return snapshot();
}

function clearEvents() {
  runtime.robot.events = [];
  render();
  return snapshot();
}

const eventSchema = {
  type: "object",
  properties: { time: { type: "string" }, message: { type: "string" } },
  required: ["time", "message"],
  additionalProperties: false,
};
const stateSchema = {
  type: "object",
  properties: {
    robot_id: { type: "string" }, x: { type: "integer" }, y: { type: "integer" }, battery: { type: "integer" },
    stage: { type: "string" }, progress: { type: "integer" }, busy: { type: "boolean" }, carrying: { type: "boolean" },
    sample_loaded: { type: "boolean" }, events: { type: "array", items: eventSchema },
  },
  required: ["robot_id", "x", "y", "battery", "stage", "progress", "busy", "carrying", "sample_loaded", "events"],
  additionalProperties: false,
};

runtime.robot = initialState();
render();

document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => {
  const units = Math.max(1, Math.min(9, Number(document.querySelector("#moveUnits").value) || 1));
  try { moveRobot(button.dataset.direction, Math.trunc(units)); } catch (error) { fail(error.message); }
}));
els.run.addEventListener("click", () => { try { startSampleTransfer(); } catch (error) { fail(error.message); } });
document.querySelector("#stopRobot").addEventListener("click", stopRobot);
document.querySelector("#resetRobot").addEventListener("click", resetRobot);
document.querySelector("#clearLog").addEventListener("click", clearEvents);
document.querySelector("#addReference").addEventListener("click", async () => {
  try {
    if (!window.atomos?.conversation?.addReference) throw new Error("Conversation API unavailable");
    const data = snapshot();
    await window.atomos.conversation.addReference({
      idempotencyKey: crypto.randomUUID(),
      label: `Robot ${data.robot_id} 状态`,
      text: `FoundryLab Robot ${data.robot_id}: stage=${data.stage}, progress=${data.progress}, position=(${data.x}, ${data.y}), battery=${data.battery}%, carrying=${data.carrying}, sample_loaded=${data.sample_loaded}.`,
      location: "FoundryLab Robot Console",
    });
    els.sdkStatus.textContent = "Robot 状态已添加到对话";
  } catch (error) {
    els.sdkStatus.textContent = `${error.message}${error.code ? ` · ${error.code}` : ""}`;
  }
});

if (window.atomos?.artifact?.exposeOperations) {
  runtime.disposeOperations = window.atomos.artifact.exposeOperations({
    get_robot_state: {
      description: "Return the current authoritative state, progress, and event history for Robot R-03.",
      outputSchema: stateSchema,
      run: () => snapshot(),
    },
    move_robot: {
      description: "Move Robot R-03 along one X/Y axis by 1-9 units. Automatic tasks must be stopped first.",
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, units: { type: "integer", minimum: 1, maximum: 9 } },
        required: ["direction", "units"],
        additionalProperties: false,
      },
      outputSchema: stateSchema,
      run: ({ direction, units }) => moveRobot(direction, units),
    },
    start_sample_transfer: {
      description: "Start the fixed transfer of sample S-2408 from ST-01 to centrifuge CF-02. Poll get_robot_state until busy=false.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["load_sample"] },
          sample_id: { type: "string", enum: ["S-2408"] },
          device_id: { type: "string", enum: ["CF-02"] },
        },
        additionalProperties: false,
      },
      outputSchema: stateSchema,
      run: (input) => startSampleTransfer(input),
    },
    stop_robot: {
      description: "Immediately stop the active Robot task and lock its current position.",
      outputSchema: stateSchema,
      run: stopRobot,
    },
    reset_robot: {
      description: "Cancel active work and reset Robot R-03 to charging dock coordinates (1, 0).",
      outputSchema: stateSchema,
      run: resetRobot,
    },
    clear_events: {
      description: "Clear the Robot event history without changing its physical state.",
      outputSchema: stateSchema,
      run: clearEvents,
    },
  });
  els.sdkStatus.textContent = "6 Agent operations ready";
} else {
  els.sdkStatus.textContent = "Artifact Host unavailable · UI controls remain active";
}

window.addEventListener("unload", () => {
  cancelScenario();
  runtime.disposeOperations?.();
}, { once: true });
