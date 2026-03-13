import { importShared } from './__federation_fn_import-BjTqTgpc.js';
import { _ as _export_sfc } from './_plugin-vue_export-helper-pcqpp-6-.js';

const {defineComponent:_defineComponent} = await importShared('vue');

const {createElementVNode:_createElementVNode,vModelText:_vModelText,withKeys:_withKeys,normalizeClass:_normalizeClass,withDirectives:_withDirectives,toDisplayString:_toDisplayString,openBlock:_openBlock,createElementBlock:_createElementBlock,createCommentVNode:_createCommentVNode,renderList:_renderList,Fragment:_Fragment,vModelCheckbox:_vModelCheckbox,createTextVNode:_createTextVNode,resolveDirective:_resolveDirective} = await importShared('vue');

const _hoisted_1 = { class: "setup-wizard" };
const _hoisted_2 = {
  key: 0,
  class: "wizard-step"
};
const _hoisted_3 = { class: "form-group" };
const _hoisted_4 = {
  key: 0,
  class: "form-error"
};
const _hoisted_5 = ["disabled"];
const _hoisted_6 = { key: 0 };
const _hoisted_7 = { key: 1 };
const _hoisted_8 = {
  key: 1,
  class: "wizard-step"
};
const _hoisted_9 = {
  key: 0,
  class: "install-section"
};
const _hoisted_10 = ["value"];
const _hoisted_11 = { class: "install-name" };
const _hoisted_12 = { class: "install-id" };
const _hoisted_13 = {
  key: 1,
  class: "install-section"
};
const _hoisted_14 = ["value"];
const _hoisted_15 = { class: "install-name" };
const _hoisted_16 = { class: "install-id" };
const _hoisted_17 = {
  key: 2,
  class: "empty-available"
};
const _hoisted_18 = { class: "step-actions" };
const _hoisted_19 = ["disabled"];
const _hoisted_20 = { key: 0 };
const _hoisted_21 = {
  key: 2,
  class: "wizard-step wizard-done"
};
const _hoisted_22 = {
  key: 3,
  class: "global-error"
};
const {ref,onMounted} = await importShared('vue');

const _sfc_main = /* @__PURE__ */ _defineComponent({
  __name: "SetupWizard",
  setup(__props) {
    const step = ref(1);
    const apiKey = ref("");
    const apiKeyError = ref("");
    const connecting = ref(false);
    const completing = ref(false);
    const globalError = ref("");
    const available = ref({
      teams: [],
      features: []
    });
    const selectedInstall = ref([]);
    onMounted(async () => {
      try {
        const res = await fetch("/api/config/status");
        const status = await res.json();
        if (status.complete) {
          window.location.href = "/";
          return;
        }
        if (status.setupCompleted) {
        }
      } catch {
      }
    });
    async function connectProvider() {
      apiKeyError.value = "";
      const key = apiKey.value.trim();
      if (!key) {
        apiKeyError.value = "API klíč nesmí být prázdný";
        return;
      }
      connecting.value = true;
      try {
        const res = await fetch("/api/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: { type: "claude-code", apiKey: key } })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const avRes = await fetch("/api/available");
        if (avRes.ok) {
          available.value = await avRes.json();
        }
        step.value = 2;
      } catch (err) {
        apiKeyError.value = `Chyba při ukládání: ${String(err)}`;
      } finally {
        connecting.value = false;
      }
    }
    async function complete() {
      completing.value = true;
      globalError.value = "";
      try {
        const res = await fetch("/api/setup/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ install: selectedInstall.value })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        step.value = 3;
        setTimeout(() => {
          window.location.href = "/";
        }, 1500);
      } catch (err) {
        globalError.value = `Chyba při spuštění: ${String(err)}`;
      } finally {
        completing.value = false;
      }
    }
    return (_ctx, _cache) => {
      const _directive_else34 = _resolveDirective('else"');
      return _openBlock(), _createElementBlock("div", _hoisted_1, [
        _cache[13] || (_cache[13] = _createElementVNode("div", { class: "wizard-header" }, [
          _createElementVNode("span", { class: "wizard-logo" }, "🤖"),
          _createElementVNode("h1", null, "Vítej v nano-agent-team"),
          _createElementVNode("p", { class: "wizard-subtitle" }, "Nastavení zabere asi 2 minuty.")
        ], -1)),
        step.value === 1 ? (_openBlock(), _createElementBlock("div", _hoisted_2, [
          _cache[5] || (_cache[5] = _createElementVNode("h2", null, "Připoj Claude", -1)),
          _cache[6] || (_cache[6] = _createElementVNode("p", { class: "step-desc" }, " nano-agent-team používá Claude jako AI backend. Zadej svůj Anthropic API klíč nebo Claude Code OAuth token. ", -1)),
          _createElementVNode("div", _hoisted_3, [
            _cache[4] || (_cache[4] = _createElementVNode("label", null, "API klíč", -1)),
            _withDirectives(_createElementVNode("input", {
              "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => apiKey.value = $event),
              type: "password",
              placeholder: "sk-ant-api03-...",
              class: _normalizeClass(["form-input", { error: apiKeyError.value }]),
              onKeyup: _withKeys(connectProvider, ["enter"])
            }, null, 34), [
              [_vModelText, apiKey.value]
            ]),
            apiKeyError.value ? (_openBlock(), _createElementBlock("span", _hoisted_4, _toDisplayString(apiKeyError.value), 1)) : _createCommentVNode("", true)
          ]),
          _createElementVNode("button", {
            class: "btn-primary",
            disabled: connecting.value,
            onClick: connectProvider
          }, [
            connecting.value ? (_openBlock(), _createElementBlock("span", _hoisted_6, "Připojuji...")) : (_openBlock(), _createElementBlock("span", _hoisted_7, "Připojit Claude →"))
          ], 8, _hoisted_5)
        ])) : _createCommentVNode("", true),
        step.value === 2 ? (_openBlock(), _createElementBlock("div", _hoisted_8, [
          _cache[10] || (_cache[10] = _createElementVNode("h2", null, "Co chceš nainstalovat?", -1)),
          _cache[11] || (_cache[11] = _createElementVNode("p", { class: "step-desc" }, " Vyber týmy a featury. Vše lze přidat nebo odebrat i později v Settings. ", -1)),
          available.value.teams.length > 0 ? (_openBlock(), _createElementBlock("div", _hoisted_9, [
            _cache[7] || (_cache[7] = _createElementVNode("h3", null, "Týmy", -1)),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(available.value.teams, (team) => {
              return _openBlock(), _createElementBlock("label", {
                key: team.id,
                class: "install-item"
              }, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  value: team.id,
                  "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => selectedInstall.value = $event)
                }, null, 8, _hoisted_10), [
                  [_vModelCheckbox, selectedInstall.value]
                ]),
                _createElementVNode("span", _hoisted_11, _toDisplayString(team.name), 1),
                _createElementVNode("span", _hoisted_12, _toDisplayString(team.id), 1)
              ]);
            }), 128))
          ])) : _createCommentVNode("", true),
          available.value.features.length > 0 ? (_openBlock(), _createElementBlock("div", _hoisted_13, [
            _cache[8] || (_cache[8] = _createElementVNode("h3", null, "Featury", -1)),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(available.value.features, (feature) => {
              return _openBlock(), _createElementBlock("label", {
                key: feature.id,
                class: "install-item"
              }, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  value: feature.id,
                  "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => selectedInstall.value = $event)
                }, null, 8, _hoisted_14), [
                  [_vModelCheckbox, selectedInstall.value]
                ]),
                _createElementVNode("span", _hoisted_15, _toDisplayString(feature.name), 1),
                _createElementVNode("span", _hoisted_16, _toDisplayString(feature.id), 1)
              ]);
            }), 128))
          ])) : _createCommentVNode("", true),
          available.value.teams.length === 0 && available.value.features.length === 0 ? (_openBlock(), _createElementBlock("div", _hoisted_17, " Zatím žádné týmy ani featury — přidáš je později přes Settings. ")) : _createCommentVNode("", true),
          _createElementVNode("div", _hoisted_18, [
            _createElementVNode("button", {
              class: "btn-secondary",
              onClick: _cache[3] || (_cache[3] = ($event) => step.value = 1)
            }, "← Zpět"),
            _createElementVNode("button", {
              class: "btn-primary",
              disabled: completing.value,
              onClick: complete
            }, [
              completing.value ? (_openBlock(), _createElementBlock("span", _hoisted_20, "Spouštím...")) : _createCommentVNode("", true),
              _withDirectives((_openBlock(), _createElementBlock("span", null, [..._cache[9] || (_cache[9] = [
                _createTextVNode("Spustit systém →", -1)
              ])])), [
                [_directive_else34]
              ])
            ], 8, _hoisted_19)
          ])
        ])) : _createCommentVNode("", true),
        step.value === 3 ? (_openBlock(), _createElementBlock("div", _hoisted_21, [..._cache[12] || (_cache[12] = [
          _createElementVNode("div", { class: "done-icon" }, "✅", -1),
          _createElementVNode("h2", null, "Systém je připraven!", -1),
          _createElementVNode("p", null, "Přesměrovávám na dashboard...", -1)
        ])])) : _createCommentVNode("", true),
        globalError.value ? (_openBlock(), _createElementBlock("div", _hoisted_22, _toDisplayString(globalError.value), 1)) : _createCommentVNode("", true)
      ]);
    };
  }
});

const SetupWizard = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-f5a764fc"]]);

export { SetupWizard as default };
