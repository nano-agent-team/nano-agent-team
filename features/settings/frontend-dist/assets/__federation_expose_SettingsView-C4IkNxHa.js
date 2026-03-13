import { importShared } from './__federation_fn_import-BjTqTgpc.js';
import { _ as _export_sfc } from './_plugin-vue_export-helper-pcqpp-6-.js';

const {defineComponent:_defineComponent} = await importShared('vue');

const {createElementVNode:_createElementVNode,toDisplayString:_toDisplayString,normalizeClass:_normalizeClass,renderList:_renderList,Fragment:_Fragment,openBlock:_openBlock,createElementBlock:_createElementBlock,createCommentVNode:_createCommentVNode,vModelText:_vModelText,withKeys:_withKeys,withDirectives:_withDirectives} = await importShared('vue');

const _hoisted_1 = { class: "settings-view" };
const _hoisted_2 = { class: "settings-body" };
const _hoisted_3 = { class: "settings-section" };
const _hoisted_4 = { class: "status-row" };
const _hoisted_5 = { class: "status-row" };
const _hoisted_6 = { class: "status-value" };
const _hoisted_7 = {
  key: 0,
  class: "missing-list"
};
const _hoisted_8 = { class: "settings-section" };
const _hoisted_9 = { class: "chat-role" };
const _hoisted_10 = { class: "chat-text" };
const _hoisted_11 = {
  key: 0,
  class: "chat-msg assistant thinking"
};
const _hoisted_12 = { class: "chat-input-row" };
const _hoisted_13 = ["disabled"];
const _hoisted_14 = ["disabled"];
const _hoisted_15 = { class: "settings-section" };
const _hoisted_16 = {
  key: 0,
  class: "installed-group"
};
const _hoisted_17 = {
  key: 1,
  class: "installed-group"
};
const _hoisted_18 = {
  key: 2,
  class: "empty-installed"
};
const {ref,onMounted,nextTick} = await importShared('vue');

const _sfc_main = /* @__PURE__ */ _defineComponent({
  __name: "SettingsView",
  setup(__props) {
    const config = ref(null);
    const status = ref({ complete: false, missing: [], setupCompleted: false });
    const messages = ref([]);
    const chatInput = ref("");
    const thinking = ref(false);
    const chatEl = ref(null);
    const sessionId = `settings-${Date.now()}`;
    onMounted(async () => {
      await Promise.all([loadConfig(), loadStatus()]);
      messages.value.push({
        role: "assistant",
        text: "Ahoj! Jsem tvůj settings asistent. Zeptej se mě na cokoliv ohledně konfigurace nebo instalace."
      });
    });
    async function loadConfig() {
      try {
        const res = await fetch("/api/config");
        if (res.ok) config.value = await res.json();
      } catch {
      }
    }
    async function loadStatus() {
      try {
        const res = await fetch("/api/config/status");
        if (res.ok) status.value = await res.json();
      } catch {
      }
    }
    async function sendMessage() {
      const text = chatInput.value.trim();
      if (!text || thinking.value) return;
      messages.value.push({ role: "user", text });
      chatInput.value = "";
      thinking.value = true;
      await scrollToBottom();
      try {
        const res = await fetch("/api/chat/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId })
        });
        if (res.ok) {
          const data = await res.json();
          const replyText = typeof data.reply === "string" ? data.reply : JSON.stringify(data.reply);
          messages.value.push({ role: "assistant", text: replyText });
          await loadConfig();
          await loadStatus();
        } else {
          messages.value.push({ role: "assistant", text: "(Asistent není dostupný — zkus to znovu)" });
        }
      } catch {
        messages.value.push({ role: "assistant", text: "(Chyba připojení k asistentovi)" });
      } finally {
        thinking.value = false;
        await scrollToBottom();
      }
    }
    async function scrollToBottom() {
      await nextTick();
      if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight;
    }
    return (_ctx, _cache) => {
      return _openBlock(), _createElementBlock("div", _hoisted_1, [
        _cache[11] || (_cache[11] = _createElementVNode("div", { class: "settings-header" }, [
          _createElementVNode("h1", null, "⚙️ Settings")
        ], -1)),
        _createElementVNode("div", _hoisted_2, [
          _createElementVNode("div", _hoisted_3, [
            _cache[4] || (_cache[4] = _createElementVNode("h2", null, "Stav systému", -1)),
            _createElementVNode("div", _hoisted_4, [
              _cache[1] || (_cache[1] = _createElementVNode("span", { class: "status-label" }, "Setup", -1)),
              _createElementVNode("span", {
                class: _normalizeClass(["status-badge", status.value.complete ? "ok" : "warn"])
              }, _toDisplayString(status.value.complete ? "Dokončen" : "Nedokončen"), 3)
            ]),
            _createElementVNode("div", _hoisted_5, [
              _cache[2] || (_cache[2] = _createElementVNode("span", { class: "status-label" }, "Provider", -1)),
              _createElementVNode("span", _hoisted_6, _toDisplayString(config.value?.provider?.type ?? "—"), 1)
            ]),
            status.value.missing?.length ? (_openBlock(), _createElementBlock("div", _hoisted_7, [
              _cache[3] || (_cache[3] = _createElementVNode("span", { class: "missing-label" }, "Chybí:", -1)),
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(status.value.missing, (m) => {
                return _openBlock(), _createElementBlock("code", {
                  key: m,
                  class: "missing-item"
                }, _toDisplayString(m), 1);
              }), 128))
            ])) : _createCommentVNode("", true)
          ]),
          _createElementVNode("div", _hoisted_8, [
            _cache[6] || (_cache[6] = _createElementVNode("h2", null, "Asistent", -1)),
            _cache[7] || (_cache[7] = _createElementVNode("p", { class: "section-desc" }, "Zeptej se na cokoliv ohledně nastavení systému.", -1)),
            _createElementVNode("div", {
              class: "chat-messages",
              ref_key: "chatEl",
              ref: chatEl
            }, [
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(messages.value, (msg, i) => {
                return _openBlock(), _createElementBlock("div", {
                  key: i,
                  class: _normalizeClass(["chat-msg", msg.role])
                }, [
                  _createElementVNode("span", _hoisted_9, _toDisplayString(msg.role === "user" ? "Ty" : "🤖"), 1),
                  _createElementVNode("span", _hoisted_10, _toDisplayString(msg.text), 1)
                ], 2);
              }), 128)),
              thinking.value ? (_openBlock(), _createElementBlock("div", _hoisted_11, [..._cache[5] || (_cache[5] = [
                _createElementVNode("span", { class: "chat-role" }, "🤖", -1),
                _createElementVNode("span", { class: "chat-text" }, "...", -1)
              ])])) : _createCommentVNode("", true)
            ], 512),
            _createElementVNode("div", _hoisted_12, [
              _withDirectives(_createElementVNode("input", {
                "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => chatInput.value = $event),
                type: "text",
                placeholder: "Napiš zprávu...",
                class: "chat-input",
                disabled: thinking.value,
                onKeyup: _withKeys(sendMessage, ["enter"])
              }, null, 40, _hoisted_13), [
                [_vModelText, chatInput.value]
              ]),
              _createElementVNode("button", {
                class: "btn-send",
                disabled: thinking.value || !chatInput.value.trim(),
                onClick: sendMessage
              }, " Odeslat ", 8, _hoisted_14)
            ])
          ]),
          _createElementVNode("div", _hoisted_15, [
            _cache[10] || (_cache[10] = _createElementVNode("h2", null, "Nainstalováno", -1)),
            config.value?.installed?.teams?.length ? (_openBlock(), _createElementBlock("div", _hoisted_16, [
              _cache[8] || (_cache[8] = _createElementVNode("span", { class: "installed-label" }, "Týmy:", -1)),
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(config.value.installed.teams, (t) => {
                return _openBlock(), _createElementBlock("code", {
                  key: t,
                  class: "installed-item"
                }, _toDisplayString(t), 1);
              }), 128))
            ])) : _createCommentVNode("", true),
            config.value?.installed?.features?.length ? (_openBlock(), _createElementBlock("div", _hoisted_17, [
              _cache[9] || (_cache[9] = _createElementVNode("span", { class: "installed-label" }, "Featury:", -1)),
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(config.value.installed.features, (f) => {
                return _openBlock(), _createElementBlock("code", {
                  key: f,
                  class: "installed-item"
                }, _toDisplayString(f), 1);
              }), 128))
            ])) : _createCommentVNode("", true),
            !config.value?.installed?.teams?.length && !config.value?.installed?.features?.length ? (_openBlock(), _createElementBlock("div", _hoisted_18, " Nic nenainstalováno. ")) : _createCommentVNode("", true)
          ])
        ])
      ]);
    };
  }
});

const SettingsView = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-69e2acb5"]]);

export { SettingsView as default };
