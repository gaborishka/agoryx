"use strict";

// The start page draws the state the app's main process sends (desktop/src/main.ts) and turns
// clicks into calls on window.agoryxDesktop (desktop/src/preload.cts). It decides nothing itself.
(() => {
  const api = window.agoryxDesktop;
  const byId = (id) => document.getElementById(id);

  const ACTIONS = {
    retry: { label: "Спробувати знову", call: () => api.retry() },
    open: { label: "Відкрити Agoryx", call: () => api.openAnyway() },
    log: { label: "Відкрити журнал", call: () => api.openLog() },
    doctor: { label: "Перевірити ще раз", call: () => api.runDoctor(false) },
    probe: { label: "Перевірити агентів", hint: "Надсилає кожному агентові, у якого виконано вхід, один короткий запит", call: () => api.runDoctor(true) },
  };
  const STEP_ICONS = { done: "✓", fail: "✕" };
  const CHECK_MARKS = { ok: "✓", warn: "!", fail: "✕" };
  const CHECK_NAMES = { ok: "гаразд", warn: "попередження", fail: "помилка" };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  const setText = (node, text) => {
    node.textContent = text || "";
    node.hidden = !text;
  };

  const renderSteps = (steps) => {
    const list = byId("steps");
    list.replaceChildren(
      ...steps.map((step) => {
        const item = el("li", "step");
        item.dataset.status = step.status;
        const icon = el("span", "step-icon", STEP_ICONS[step.status]);
        icon.setAttribute("aria-hidden", "true");
        if (step.status === "run") icon.append(el("span", "spinner"));
        item.append(icon, el("span", "step-label", step.label));
        if (step.detail) item.append(el("span", "step-detail", step.detail));
        return item;
      }),
    );
    list.hidden = steps.length === 0;
  };

  const copy = async (text, button, code) => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Скопійовано";
    } catch {
      getSelection()?.selectAllChildren(code);
      button.textContent = "Натисніть ⌘C";
    }
    setTimeout(() => {
      button.textContent = "Копіювати";
    }, 1600);
  };

  const renderChecks = (checks) => {
    const list = byId("checks");
    list.replaceChildren(
      ...checks.map((check) => {
        const item = el("li", "check");
        item.dataset.status = check.status;
        const mark = el("span", "check-mark", CHECK_MARKS[check.status] || "?");
        mark.setAttribute("aria-label", CHECK_NAMES[check.status] || check.status);
        const body = el("div", "check-body");
        const line = el("div");
        line.append(el("span", "check-label", check.label));
        if (check.detail) line.append(el("span", "check-detail", check.detail));
        body.append(line);
        if (check.fix && check.status !== "ok") {
          const fix = el("div", "fix");
          const code = el("code", "", check.fix);
          const button = el("button", "copy", "Копіювати");
          button.type = "button";
          button.addEventListener("click", () => void copy(check.fix, button, code));
          fix.append(code, button);
          body.append(fix);
        }
        item.append(mark, body);
        return item;
      }),
    );
    list.hidden = checks.length === 0;
  };

  const renderProblem = (error) => {
    const box = byId("problem");
    box.hidden = !error;
    if (!error) return;
    setText(byId("problem-message"), error.message);
    setText(byId("problem-log"), error.logTail);
    setText(byId("problem-path"), error.logPath);
    const log = byId("problem-log");
    log.scrollTop = log.scrollHeight;
  };

  const renderActions = (actions) => {
    byId("actions").replaceChildren(
      ...actions
        .filter((id) => ACTIONS[id])
        .map((id, index) => {
          const action = ACTIONS[id];
          const button = el("button", index === 0 ? "primary" : "", action.label);
          button.type = "button";
          if (action.hint) button.title = action.hint;
          // Disabled until the next state arrives: one click, one call.
          button.addEventListener("click", () => {
            button.disabled = true;
            Promise.resolve(action.call()).catch(() => {
              button.disabled = false;
            });
          });
          return button;
        }),
    );
  };

  let rev = -1;
  const render = (state) => {
    if (!state || state.rev < rev) return;
    rev = state.rev;
    byId("title").textContent = state.title;
    setText(byId("note"), state.note);
    document.body.setAttribute("aria-busy", String(Boolean(state.busy)));
    renderSteps(state.steps || []);
    renderProblem(state.error);
    renderChecks(state.checks || []);
    renderActions(state.actions || []);
  };

  if (!api) {
    byId("title").textContent = "Agoryx";
    setText(byId("note"), "Ця сторінка працює всередині застосунку Agoryx.");
    return;
  }
  api.onState(render);
})();
