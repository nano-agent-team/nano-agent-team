import { importShared } from './__federation_fn_import-BjTqTgpc.js';

const {defineComponent:_defineComponent} = await importShared('vue');

const {createElementVNode:_createElementVNode,openBlock:_openBlock,createElementBlock:_createElementBlock,createCommentVNode:_createCommentVNode,renderList:_renderList,Fragment:_Fragment,toDisplayString:_toDisplayString,normalizeClass:_normalizeClass,vModelText:_vModelText,withKeys:_withKeys,withDirectives:_withDirectives,createStaticVNode:_createStaticVNode} = await importShared('vue');

const _hoisted_1 = { class: "chat-container" };
const _hoisted_2 = {
  key: 0,
  class: "chat-empty"
};
const _hoisted_3 = { class: "chat-bubble" };
const _hoisted_4 = { class: "chat-role" };
const _hoisted_5 = { class: "chat-text" };
const _hoisted_6 = {
  key: 1,
  class: "chat-message chat-message--agent"
};
const _hoisted_7 = { class: "chat-input-area" };
const _hoisted_8 = ["disabled"];
const _hoisted_9 = ["disabled"];
const {ref,nextTick} = await importShared('vue');

const _sfc_main = /* @__PURE__ */ _defineComponent({
  __name: "SimpleChatView",
  setup(__props) {
    const messages = ref([]);
    const inputText = ref("");
    const loading = ref(false);
    const messagesEl = ref(null);
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    async function scrollToBottom() {
      await nextTick();
      if (messagesEl.value) {
        messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
      }
    }
    async function sendMessage() {
      const text = inputText.value.trim();
      if (!text || loading.value) return;
      messages.value.push({ role: "user", text });
      inputText.value = "";
      loading.value = true;
      await scrollToBottom();
      try {
        const res = await fetch("/api/chat/simple-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          messages.value.push({ role: "agent", text: `Chyba: ${err.error ?? res.statusText}` });
        } else {
          const data = await res.json();
          const replyText = typeof data.reply === "string" ? data.reply : JSON.stringify(data.reply);
          messages.value.push({ role: "agent", text: replyText });
        }
      } catch (err) {
        messages.value.push({ role: "agent", text: `Síťová chyba: ${String(err)}` });
      } finally {
        loading.value = false;
        await scrollToBottom();
      }
    }
    return (_ctx, _cache) => {
      return _openBlock(), _createElementBlock("div", _hoisted_1, [
        _cache[3] || (_cache[3] = _createElementVNode("div", { class: "chat-header" }, [
          _createElementVNode("span", { class: "chat-icon" }, "💬"),
          _createElementVNode("h1", null, "Chat")
        ], -1)),
        _createElementVNode("div", {
          class: "chat-messages",
          ref_key: "messagesEl",
          ref: messagesEl
        }, [
          messages.value.length === 0 ? (_openBlock(), _createElementBlock("div", _hoisted_2, [..._cache[1] || (_cache[1] = [
            _createElementVNode("p", null, "Začni konverzaci — napiš zprávu níže.", -1)
          ])])) : _createCommentVNode("", true),
          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(messages.value, (msg, idx) => {
            return _openBlock(), _createElementBlock("div", {
              key: idx,
              class: _normalizeClass(["chat-message", msg.role === "user" ? "chat-message--user" : "chat-message--agent"])
            }, [
              _createElementVNode("div", _hoisted_3, [
                _createElementVNode("span", _hoisted_4, _toDisplayString(msg.role === "user" ? "Ty" : "Agent"), 1),
                _createElementVNode("p", _hoisted_5, _toDisplayString(msg.text), 1)
              ])
            ], 2);
          }), 128)),
          loading.value ? (_openBlock(), _createElementBlock("div", _hoisted_6, [..._cache[2] || (_cache[2] = [
            _createStaticVNode('<div class="chat-bubble" data-v-d3cbe001><span class="chat-role" data-v-d3cbe001>Agent</span><p class="chat-text chat-loading" data-v-d3cbe001><span class="dot" data-v-d3cbe001>.</span><span class="dot" data-v-d3cbe001>.</span><span class="dot" data-v-d3cbe001>.</span></p></div>', 1)
          ])])) : _createCommentVNode("", true)
        ], 512),
        _createElementVNode("div", _hoisted_7, [
          _withDirectives(_createElementVNode("input", {
            "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => inputText.value = $event),
            class: "chat-input",
            type: "text",
            placeholder: "Napiš zprávu...",
            disabled: loading.value,
            onKeyup: _withKeys(sendMessage, ["enter"])
          }, null, 40, _hoisted_8), [
            [_vModelText, inputText.value]
          ]),
          _createElementVNode("button", {
            class: "chat-send-btn",
            disabled: loading.value || !inputText.value.trim(),
            onClick: sendMessage
          }, " Odeslat ", 8, _hoisted_9)
        ])
      ]);
    };
  }
});

const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};

const SimpleChatView = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-d3cbe001"]]);

export { SimpleChatView as default };
