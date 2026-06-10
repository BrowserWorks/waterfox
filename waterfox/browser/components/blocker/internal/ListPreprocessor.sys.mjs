/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// These tokens describe this blocker implementation, not only the browser
// engine. Keep parser/runtime capabilities false until both adblock-rs and the
// Gecko integration enforce the selected rule syntax.
export const DEFAULT_PREPROCESSOR_TOKENS = Object.freeze({
  adguard: false,
  adguard_app_android: false,
  adguard_app_cli: false,
  adguard_app_ios: false,
  adguard_app_mac: false,
  adguard_app_windows: false,
  adguard_ext_android_cb: false,
  adguard_ext_chromium: false,
  adguard_ext_chromium_mv3: false,
  adguard_ext_edge: false,
  adguard_ext_firefox: false,
  adguard_ext_opera: false,
  adguard_ext_safari: false,
  cap_html_filtering: false,
  cap_ipaddress: false,
  cap_user_stylesheet: false,
  env_chromium: false,
  env_devbuild: false,
  env_edge: false,
  env_firefox: true,
  env_legacy: false,
  env_mobile: false,
  env_mv3: false,
  env_safari: false,
  ext_abp: false,
  ext_devbuild: false,
  ext_ublock: false,
  ext_ubol: false,
  false: false,
  true: true,
});

// Only conditional directives are evaluated; other !# directives remain comments.
const DIRECTIVE_RE = /^\s*!#(if|else|endif)\b(.*)$/;
const TOKEN_RE = /\s*(&&|\|\||!|\(|\)|[A-Za-z_][A-Za-z0-9_]*)/gy;

function tokenizeExpression(expression) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;

  while (TOKEN_RE.lastIndex < expression.length) {
    const match = TOKEN_RE.exec(expression);
    if (!match) {
      return null;
    }
    tokens.push(match[1]);
  }

  return tokens;
}

function evaluateExpression(expression, tokenValues) {
  const tokens = tokenizeExpression(expression.trim());
  if (!tokens) {
    return false;
  }

  let index = 0;

  function peek() {
    return tokens[index];
  }

  function consume(expected) {
    if (tokens[index] !== expected) {
      return false;
    }
    index++;
    return true;
  }

  function parsePrimary() {
    const token = peek();
    if (token === undefined) {
      throw new Error("Unexpected end of expression");
    }

    if (consume("(")) {
      const value = parseOr();
      if (!consume(")")) {
        throw new Error("Missing closing parenthesis");
      }
      return value;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      throw new Error("Expected token name");
    }

    index++;
    return tokenValues[token] === true;
  }

  function parseUnary() {
    if (consume("!")) {
      return !parseUnary();
    }
    return parsePrimary();
  }

  function parseAnd() {
    let value = parseUnary();
    while (consume("&&")) {
      const nextValue = parseUnary();
      value = value && nextValue;
    }
    return value;
  }

  function parseOr() {
    let value = parseAnd();
    while (consume("||")) {
      const nextValue = parseAnd();
      value = value || nextValue;
    }
    return value;
  }

  try {
    const value = parseOr();
    if (index !== tokens.length) {
      return false;
    }
    return value;
  } catch (_) {
    return false;
  }
}

export function preprocessFilterListText(
  text,
  tokenValues = DEFAULT_PREPROCESSOR_TOKENS
) {
  const output = [];
  const stack = [];
  let active = true;

  for (const line of String(text || "").split(/\r?\n/)) {
    const directive = DIRECTIVE_RE.exec(line);
    if (!directive) {
      if (active) {
        output.push(line);
      }
      continue;
    }

    const [, command, expression] = directive;

    if (command === "if") {
      const parentActive = active;
      const conditionResult = evaluateExpression(expression, tokenValues);
      stack.push({
        conditionResult,
        elseSeen: false,
        parentActive,
      });
      active = parentActive && conditionResult;
      continue;
    }

    const frame = stack[stack.length - 1];
    if (!frame) {
      continue;
    }

    if (command === "else") {
      if (frame.elseSeen) {
        active = false;
        continue;
      }
      frame.elseSeen = true;
      active = frame.parentActive && !frame.conditionResult;
      continue;
    }

    stack.pop();
    active = frame.parentActive;
  }

  return output.join("\n");
}

export const ListPreprocessor = Object.freeze({
  DEFAULT_PREPROCESSOR_TOKENS,
  preprocessFilterListText,
});
