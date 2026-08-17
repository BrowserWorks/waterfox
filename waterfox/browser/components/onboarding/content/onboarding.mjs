/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const STEPS = ["welcome", "import", "appearance", "tabs", "finish"];

// data-l10n-id for the primary button on each step.
const PRIMARY_LABELS = {
  welcome: "waterfox-onboarding-start-button",
  import: "waterfox-onboarding-continue-button",
  appearance: "waterfox-onboarding-continue-button",
  tabs: "waterfox-onboarding-continue-button",
  finish: "waterfox-onboarding-finish-primary-button",
};

const SKIPPABLE = new Set(["import", "appearance", "tabs"]);

let state;
let currentStep = 0;

function query(queryName, data) {
  return window.WFXOnboardingQuery(queryName, data);
}

function apply(action, value) {
  query("Apply", { action, value }).catch(console.error);
}

function el(id) {
  return document.getElementById(id);
}

function markSelected(container, value) {
  for (const button of container.querySelectorAll("[data-value]")) {
    button.toggleAttribute("selected", button.dataset.value === value);
    button.setAttribute(
      "aria-pressed",
      button.dataset.value === value ? "true" : "false"
    );
  }
}

function wireGroup(container, action, onChange) {
  container.addEventListener("click", event => {
    const button = event.target.closest("[data-value]");
    if (!button) {
      return;
    }
    markSelected(container, button.dataset.value);
    apply(action, button.dataset.value);
    onChange?.(button.dataset.value);
  });
}

function populateLocales() {
  const select = el("locale-select");
  for (const { value, label } of state.locales.options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = state.locales.selected;
  select.disabled = state.locales.options.length < 2;

  let requestInFlight = false;
  select.addEventListener("change", async () => {
    if (requestInFlight) {
      return;
    }
    const previous = state.locales.selected;
    const requested = select.value;
    requestInFlight = true;
    select.disabled = true;
    el("locale-error").hidden = true;
    try {
      await query("SetLocale", requested);
      state.locales.selected = requested;
    } catch (_) {
      select.value = previous;
      el("locale-error").hidden = false;
    } finally {
      requestInFlight = false;
      select.disabled = false;
    }
  });
}

function buildColorGrid() {
  const grid = el("color-grid");
  for (const { id, labelId, swatch } of state.colors) {
    const button = document.createElement("button");
    button.className = "color-tile";
    button.dataset.value = id;

    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = swatch;

    const label = document.createElement("span");
    label.className = "color-label";
    document.l10n.setAttributes(label, labelId);

    button.append(dot, label);
    grid.appendChild(button);
  }
}

function updateTabLocationField(layout) {
  // The strip position only applies to the horizontal layout.
  el("tab-location-field").classList.toggle("dimmed", layout !== "horizontal");
}

function showStep(index) {
  currentStep = index;
  const stepName = STEPS[index];

  STEPS.forEach((step, i) => {
    el(`step-${step}`).hidden = i !== index;
  });

  document.l10n.setAttributes(
    el("step-counter"),
    "waterfox-onboarding-step-label",
    {
      current: index + 1,
      total: STEPS.length,
    }
  );

  const progress = el("progress");
  progress.setAttribute("aria-valuenow", index + 1);
  progress.querySelectorAll(".segment").forEach((segment, i) => {
    segment.toggleAttribute("filled", i <= index);
  });

  el("back-button").hidden = index === 0;
  el("skip-button").hidden = !SKIPPABLE.has(stepName);
  document.l10n.setAttributes(el("next-button"), PRIMARY_LABELS[stepName]);
}

function advance(delta) {
  const next = currentStep + delta;
  if (next < 0 || next >= STEPS.length) {
    return;
  }
  showStep(next);
}

async function init() {
  state = await query("Init");

  populateLocales();
  buildColorGrid();

  markSelected(el("style-tiles"), state.current.style);
  markSelected(el("density-segments"), state.current.density);
  markSelected(el("mode-segments"), state.current.mode);
  markSelected(el("color-grid"), state.current.color);
  markSelected(el("layout-tiles"), state.current.layout);
  markSelected(el("location-segments"), state.current.tabLocation);
  updateTabLocationField(state.current.layout);

  wireGroup(el("style-tiles"), "style");
  wireGroup(el("density-segments"), "density");
  wireGroup(el("mode-segments"), "theme-mode");
  wireGroup(el("color-grid"), "theme-color");
  wireGroup(el("layout-tiles"), "layout", updateTabLocationField);
  wireGroup(el("location-segments"), "tab-location");

  el("privacy-note").hidden = !state.blockerEnabled;
  el("privacy-settings").addEventListener("click", () => {
    query("OpenSettings", "privacy").catch(console.error);
  });

  el("import-wizard").addEventListener("MigrationWizard:Close", () => {
    if (STEPS[currentStep] === "import") {
      advance(1);
    }
  });

  el("back-button").addEventListener("click", () => advance(-1));
  el("skip-button").addEventListener("click", () => advance(1));
  el("next-button").addEventListener("click", () => {
    if (STEPS[currentStep] === "finish") {
      query("Finish").catch(console.error);
    } else {
      advance(1);
    }
  });

  showStep(0);
  el("onboarding").hidden = false;
}

init().catch(console.error);
