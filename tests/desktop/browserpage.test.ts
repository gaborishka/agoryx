import assert from "node:assert/strict";
import { test } from "node:test";
import { browserStep as toolsStep } from "../../internal/agora/browsertools.js";
import {
  AGORYX_PORTS,
  browserStep,
  clip,
  formatSnapshot,
  isAgoryxAddress,
  isLoopbackHost,
  keyEvents,
  paneUrl,
  RefTable,
  URL_ERROR_TEXT,
  type AXNode,
  type KeyStroke,
} from "../../internal/desktop/browserpage.js";

/** Blocked as the pane blocks: Agoryx's ports, and one the app has seen (a daemon on port 0). */
const SEEN = new Set([45123]);
const blocked = (port: number) => AGORYX_PORTS.includes(port) || SEEN.has(port);

test("paneUrl: http, https and about:blank open; other schemes do not", () => {
  assert.deepEqual(paneUrl("https://example.com/a?b=1#c", blocked), { url: "https://example.com/a?b=1#c" });
  assert.deepEqual(paneUrl("  http://example.com  ", blocked), { url: "http://example.com/" });
  assert.deepEqual(paneUrl("about:blank", blocked), { url: "about:blank" });
  for (const input of ["about:config", "about:blank#x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi",
    "chrome://settings", "devtools://devtools/bundled/inspector.html", "ftp://example.com", "mailto:ivan@example.com"]) {
    assert.deepEqual(paneUrl(input, blocked), { error: "scheme" }, input);
  }
});

test("paneUrl: a bare host is http on this machine and https elsewhere", () => {
  assert.deepEqual(paneUrl("localhost:5173", blocked), { url: "http://localhost:5173/" });
  assert.deepEqual(paneUrl("localhost:5173/settings?tab=2", blocked), { url: "http://localhost:5173/settings?tab=2" });
  assert.deepEqual(paneUrl("127.0.0.1:3000", blocked), { url: "http://127.0.0.1:3000/" });
  assert.deepEqual(paneUrl("[::1]:8080/x", blocked), { url: "http://[::1]:8080/x" });
  assert.deepEqual(paneUrl("app.localhost", blocked), { url: "http://app.localhost/" });
  assert.deepEqual(paneUrl("example.com", blocked), { url: "https://example.com/" });
  assert.deepEqual(paneUrl("example.com:8443/path", blocked), { url: "https://example.com:8443/path" });
});

test("paneUrl: each error code", () => {
  assert.deepEqual(paneUrl("", blocked), { error: "empty" });
  assert.deepEqual(paneUrl("   ", blocked), { error: "empty" });
  assert.deepEqual(paneUrl(`https://example.com/${"a".repeat(8000)}`, blocked), { error: "too-long" });
  assert.deepEqual(paneUrl("http://", blocked), { error: "invalid" });
  assert.deepEqual(paneUrl("http://exa mple.com", blocked), { error: "invalid" });
  assert.deepEqual(paneUrl("mailto:x@y", blocked), { error: "scheme" });
  assert.deepEqual(paneUrl("http://127.0.0.1:7717/", blocked), { error: "agoryx" });
  for (const code of ["empty", "too-long", "invalid", "scheme", "agoryx"] as const) assert.ok(URL_ERROR_TEXT[code].length > 0);
});

test("paneUrl: every spelling of this machine is refused on Agoryx's ports and on a seen port", () => {
  const hosts = ["127.0.0.1", "127.0.0.2", "127.1", "0x7f.1", "2130706433", "localhost", "localhost.", "app.localhost",
    "LOCALHOST", "[::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:127.0.0.9]", "0.0.0.0",
    "[::ffff:0.0.0.0]", "[::ffff:0:0]"];
  for (const host of hosts) {
    for (const port of [7717, 7736, 45123]) {
      assert.deepEqual(paneUrl(`http://${host}:${port}/`, blocked), { error: "agoryx" }, `${host}:${port}`);
      assert.deepEqual(paneUrl(`https://${host}:${port}/api/rooms`, blocked), { error: "agoryx" }, `https ${host}:${port}`);
    }
    // Port 7737 is past Agoryx's range, and 5173 is a dev server's.
    for (const port of [7737, 5173]) assert.ok("url" in paneUrl(`http://${host}:${port}/`, blocked), `${host}:${port}`);
  }
  for (const bare of ["localhost:7717", "127.0.0.1:7736/api/rooms", "[::1]:45123"]) {
    assert.deepEqual(paneUrl(bare, blocked), { error: "agoryx" }, bare);
  }
  // The default ports count: a daemon seen on 80 blocks http://localhost/.
  assert.deepEqual(paneUrl("http://localhost/", (port) => port === 80), { error: "agoryx" });
  assert.ok("url" in paneUrl("https://localhost/", (port) => port === 80));
  // Not this machine: the same ports are someone else's.
  assert.ok("url" in paneUrl("http://example.com:7717/", blocked));
  assert.ok("url" in paneUrl("http://128.0.0.1:7717/", blocked));
  assert.ok("url" in paneUrl("http://[::2]:7717/", blocked));
});

test("isLoopbackHost and isAgoryxAddress", () => {
  for (const host of ["localhost", "a.b.localhost", "127.255.255.254", "0.0.0.0", "[::1]", "::1", "::", "::ffff:127.0.0.1",
    "::ffff:7fff:ffff", "localhost.", "::ffff:0.0.0.0", "::ffff:0:0"]) {
    assert.ok(isLoopbackHost(host), host);
  }
  for (const host of ["example.com", "localhost.example.com", "notlocalhost", "10.0.0.1", "126.255.255.255", "::2",
    "::ffff:128.0.0.1", "::ffff:10.0.0.1", "::ffff:0.0.0.1", "::ffff:0.1.0.0", "fe80::1", "1::"]) {
    assert.ok(!isLoopbackHost(host), host);
  }
  assert.equal(AGORYX_PORTS.length, 20);
  assert.ok(isAgoryxAddress("http://127.0.0.1:7717/api/rooms", new Set()));
  assert.ok(isAgoryxAddress("ws://localhost:7720/", new Set()));
  assert.ok(isAgoryxAddress("http://[::1]:45123/", SEEN));
  assert.ok(isAgoryxAddress("http://localhost/", new Set([80])));
  assert.ok(!isAgoryxAddress("http://localhost:45123/", new Set()));
  assert.ok(!isAgoryxAddress("https://example.com:7717/", new Set()));
  assert.ok(!isAgoryxAddress("not a url", new Set([7717])));
});

test("RefTable: refs are monotonic, stable for a node, and never reused after a new document", () => {
  const refs = new RefTable();
  assert.equal(refs.ref(101), "e1");
  assert.equal(refs.ref(102), "e2");
  assert.equal(refs.ref(101), "e1");
  assert.equal(refs.node("e2"), 102);
  refs.forgetDocument();
  assert.equal(refs.node("e1"), undefined);
  assert.equal(refs.node("e2"), undefined);
  // The same backend id in the next document is a new node, with a new number.
  assert.equal(refs.ref(101), "e3");
  assert.equal(refs.node("e3"), 101);
  assert.equal(refs.node("e1"), undefined);
});

/** A small AX tree as CDP's Accessibility.getFullAXTree gives it. */
const node = (nodeId: string, role: string, extra: Partial<AXNode> & { name?: string; value?: string } = {}): AXNode => {
  const { name, value, ...rest } = extra;
  return {
    nodeId,
    role: { type: "role", value: role },
    ...(name !== undefined ? { name: { type: "computedString", value: name } } : {}),
    ...(value !== undefined ? { value: { type: "string", value } } : {}),
    ...rest,
  };
};

const FIXTURE: AXNode[] = [
  node("1", "RootWebArea", { name: "Settings", childIds: ["2"], backendDOMNodeId: 1 }),
  node("2", "generic", { parentId: "1", childIds: ["3", "4", "12"], backendDOMNodeId: 2 }),
  node("3", "heading", { name: "Налаштування", parentId: "2", childIds: ["3t"], backendDOMNodeId: 3,
    properties: [{ name: "level", value: { type: "integer", value: 2 } }] }),
  node("3t", "StaticText", { name: "Налаштування", parentId: "3", childIds: ["3i"], backendDOMNodeId: 30 }),
  node("3i", "InlineTextBox", { name: "Налаштування", parentId: "3t" }),
  node("4", "none", { parentId: "2", childIds: ["5", "6", "7", "8", "9", "10", "11"], backendDOMNodeId: 4 }),
  node("5", "paragraph", { parentId: "4", childIds: ["5t", "5b", "5u"], backendDOMNodeId: 5 }),
  node("5t", "StaticText", { name: "Змініть «ім'я»", parentId: "5", backendDOMNodeId: 50 }),
  node("5b", "LineBreak", { name: "\n", parentId: "5", backendDOMNodeId: 51 }),
  node("5u", "StaticText", { name: "   ", parentId: "5", backendDOMNodeId: 52 }),
  node("6", "textbox", { name: "Ім'я", value: "Іван", parentId: "4", backendDOMNodeId: 6,
    properties: [{ name: "focused", value: { type: "boolean", value: true } }, { name: "required", value: { type: "boolean", value: true } }] }),
  node("7", "checkbox", { name: "Сповіщення", parentId: "4", backendDOMNodeId: 7,
    properties: [{ name: "checked", value: { type: "tristate", value: "true" } }] }),
  node("8", "checkbox", { name: "Звук", parentId: "4", backendDOMNodeId: 8,
    properties: [{ name: "checked", value: { type: "tristate", value: "false" } }, { name: "disabled", value: { type: "boolean", value: true } }] }),
  node("9", "link", { name: "Документація", parentId: "4", childIds: ["9t"], backendDOMNodeId: 9,
    properties: [{ name: "url", value: { type: "string", value: "https://example.com/docs" } }] }),
  node("9t", "StaticText", { name: "Документація", parentId: "9", backendDOMNodeId: 90 }),
  node("10", "combobox", { name: "Місто", value: "Київ", parentId: "4", backendDOMNodeId: 10,
    properties: [{ name: "expanded", value: { type: "booleanOrUndefined", value: false } }] }),
  node("11", "button", { parentId: "4", childIds: ["11i"], backendDOMNodeId: 11 }),
  node("11i", "img", { name: "Зберегти", parentId: "11", backendDOMNodeId: 110 }),
  node("12", "list", { parentId: "2", childIds: ["13", "14"], backendDOMNodeId: 12 }),
  node("13", "listitem", { parentId: "12", childIds: ["13t"], backendDOMNodeId: 13 }),
  node("13t", "StaticText", { name: "Перший", parentId: "13", backendDOMNodeId: 130 }),
  node("14", "generic", { ignored: true, parentId: "12", childIds: ["15"], backendDOMNodeId: 14 }),
  node("15", "button", { name: "Ще", parentId: "14", backendDOMNodeId: 15 }),
];

test("formatSnapshot: hoisting, attributes, links, values and refs", () => {
  const refs = new RefTable();
  const outline = formatSnapshot(FIXTURE, refs);
  assert.equal(
    outline,
    [
      '- heading "Налаштування" [level=2] [ref=e1]',
      "- paragraph",
      '  - text: "Змініть «ім\'я»"',
      '- textbox "Ім\'я" [focused] [required] [ref=e2]: Іван',
      '- checkbox "Сповіщення" [checked] [ref=e3]',
      '- checkbox "Звук" [disabled] [ref=e4]',
      '- link "Документація" [ref=e5] -> https://example.com/docs',
      '- combobox "Місто" [expanded=false] [ref=e6]: Київ',
      "- button [ref=e7]",
      '  - img "Зберегти" [ref=e8]',
      "- list",
      "  - listitem",
      '    - text: "Перший"',
      '  - button "Ще" [ref=e9]',
    ].join("\n"),
  );
  assert.equal(refs.node("e2"), 6);
  assert.equal(refs.node("e7"), 11);
  // A second snapshot of the same page keeps every ref.
  assert.equal(formatSnapshot(FIXTURE, refs), outline);
});

test("formatSnapshot: the cut at maxChars says how many nodes are left, and hands out no refs for them", () => {
  const refs = new RefTable();
  const outline = formatSnapshot(FIXTURE, refs, { maxChars: 120 });
  const lines = outline.split("\n");
  assert.deepEqual(lines.slice(0, 3), ['- heading "Налаштування" [level=2] [ref=e1]', "- paragraph", '  - text: "Змініть «ім\'я»"']);
  assert.equal(lines[3], "… 11 more nodes (scroll, or narrow down with browser_eval)");
  assert.equal(lines.length, 4);
  assert.equal(refs.node("e2"), undefined);
  assert.equal(refs.ref(999), "e2");
});

const pressed = (strokes: KeyStroke[] | { error: string }): KeyStroke[] => {
  assert.ok(Array.isArray(strokes), JSON.stringify(strokes));
  for (const stroke of strokes) assert.ok(!("commands" in stroke), "no stroke carries editing commands");
  return strokes;
};

test("keyEvents: Enter, Shift+Tab, Ctrl+Shift+ArrowLeft, characters", () => {
  assert.deepEqual(pressed(keyEvents("Enter")), [
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" },
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
  ]);
  assert.deepEqual(pressed(keyEvents("Shift+Tab")), [
    { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
    { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 },
  ]);
  assert.deepEqual(pressed(keyEvents("Ctrl+Shift+ArrowLeft")), [
    { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 },
    { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 10 },
    { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 10 },
    { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 10 },
    { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 2 },
    { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 },
  ]);
  assert.deepEqual(pressed(keyEvents("Space"))[0], { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0, text: " " });
  assert.deepEqual(pressed(keyEvents("pagedown"))[0], { type: "rawKeyDown", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, modifiers: 0 });
  assert.deepEqual(pressed(keyEvents("F12"))[0], { type: "rawKeyDown", key: "F12", code: "F12", windowsVirtualKeyCode: 123, modifiers: 0 });
  assert.deepEqual(pressed(keyEvents("Shift+a"))[1], { type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A" });
  assert.deepEqual(pressed(keyEvents("ї"))[0], { type: "keyDown", key: "ї", code: "", windowsVirtualKeyCode: 0, modifiers: 0, text: "ї" });
  assert.deepEqual(pressed(keyEvents("+"))[0], { type: "keyDown", key: "+", code: "", windowsVirtualKeyCode: 0, modifiers: 0, text: "+" });
  // A key held with Control, Alt or Meta types nothing.
  assert.deepEqual(pressed(keyEvents("Option+Ctrl+k"))[2], { type: "rawKeyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 3 });
  const selectAll = pressed(keyEvents("Cmd+a"));
  assert.deepEqual(selectAll[1], { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
});

test("keyEvents: a bad key and the clipboard shortcuts are refused", () => {
  for (const spec of ["Foo", "Hyper+a", "Shift+", "", "Ctrl+Insert", "ab"]) {
    const result = keyEvents(spec);
    assert.ok(!Array.isArray(result) && /unknown key/.test(result.error), spec);
  }
  for (const spec of ["Meta+v", "Meta+c", "Meta+x", "Cmd+V", "Meta+Shift+v"]) {
    assert.deepEqual(keyEvents(spec), { error: "clipboard shortcuts are not available in the room's browser; browser_type types text" }, spec);
  }
});

test("clip, and browserStep is the tools' own", () => {
  assert.equal(clip("abcdef", 10), "abcdef");
  assert.equal(clip("abcdef", 4), "abcd… (2 more characters)");
  assert.equal(browserStep, toolsStep);
  assert.equal(browserStep("type", { ref: "e5", text: "secret" }), "type e5 (6 characters)");
});
