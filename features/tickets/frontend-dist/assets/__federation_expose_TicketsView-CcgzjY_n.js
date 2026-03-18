import { importShared } from './__federation_fn_import-BjTqTgpc.js';

const {defineComponent:_defineComponent} = await importShared('vue');

const {createElementVNode:_createElementVNode,openBlock:_openBlock,createElementBlock:_createElementBlock,createCommentVNode:_createCommentVNode,toDisplayString:_toDisplayString,renderList:_renderList,Fragment:_Fragment,normalizeStyle:_normalizeStyle,normalizeClass:_normalizeClass,createTextVNode:_createTextVNode,vModelText:_vModelText,withDirectives:_withDirectives,withModifiers:_withModifiers,Transition:_Transition,withCtx:_withCtx,createVNode:_createVNode,vModelSelect:_vModelSelect} = await importShared('vue');

const _hoisted_1 = { class: "tickets-root" };
const _hoisted_2 = {
  key: 0,
  class: "state-msg"
};
const _hoisted_3 = {
  key: 1,
  class: "state-msg error"
};
const _hoisted_4 = {
  key: 2,
  class: "kanban-wrapper"
};
const _hoisted_5 = { class: "kanban-board" };
const _hoisted_6 = { class: "column-title" };
const _hoisted_7 = { class: "column-count" };
const _hoisted_8 = { class: "column-body" };
const _hoisted_9 = ["onClick"];
const _hoisted_10 = { class: "card-top" };
const _hoisted_11 = { class: "ticket-id" };
const _hoisted_12 = { class: "card-title" };
const _hoisted_13 = {
  key: 0,
  class: "card-assignee"
};
const _hoisted_14 = {
  key: 0,
  class: "empty-col"
};
const _hoisted_15 = { class: "rejected-section" };
const _hoisted_16 = {
  key: 0,
  class: "rejected-cards"
};
const _hoisted_17 = ["onClick"];
const _hoisted_18 = { class: "card-top" };
const _hoisted_19 = { class: "ticket-id" };
const _hoisted_20 = { class: "card-title" };
const _hoisted_21 = {
  key: 0,
  class: "empty-col"
};
const _hoisted_22 = { class: "detail-panel" };
const _hoisted_23 = { class: "panel-header" };
const _hoisted_24 = { class: "panel-title" };
const _hoisted_25 = { class: "panel-meta" };
const _hoisted_26 = { class: "meta-row" };
const _hoisted_27 = { class: "meta-value" };
const _hoisted_28 = { class: "meta-row" };
const _hoisted_29 = { class: "meta-row" };
const _hoisted_30 = { class: "meta-value" };
const _hoisted_31 = { class: "meta-row" };
const _hoisted_32 = { class: "meta-value" };
const _hoisted_33 = { class: "meta-row" };
const _hoisted_34 = { class: "meta-value" };
const _hoisted_35 = { class: "panel-transitions" };
const _hoisted_36 = {
  key: 0,
  class: "completed-badge"
};
const _hoisted_37 = {
  key: 1,
  class: "transition-buttons"
};
const _hoisted_38 = ["disabled"];
const _hoisted_39 = ["disabled"];
const _hoisted_40 = ["disabled"];
const _hoisted_41 = ["disabled"];
const _hoisted_42 = ["disabled"];
const _hoisted_43 = ["disabled"];
const _hoisted_44 = ["disabled"];
const _hoisted_45 = ["disabled"];
const _hoisted_46 = ["disabled"];
const _hoisted_47 = ["disabled"];
const _hoisted_48 = {
  key: 2,
  class: "transition-error"
};
const _hoisted_49 = { class: "panel-comment" };
const _hoisted_50 = ["disabled"];
const _hoisted_51 = {
  key: 0,
  class: "transition-error"
};
const _hoisted_52 = { class: "modal" };
const _hoisted_53 = { class: "modal-header" };
const _hoisted_54 = { class: "form-field" };
const _hoisted_55 = { class: "form-field" };
const _hoisted_56 = { class: "form-field" };
const _hoisted_57 = {
  key: 0,
  class: "transition-error"
};
const _hoisted_58 = { class: "form-actions" };
const _hoisted_59 = ["disabled"];
const {ref,onMounted,onUnmounted} = await importShared('vue');

const _sfc_main = /* @__PURE__ */ _defineComponent({
  __name: "TicketsView",
  setup(__props) {
    const tickets = ref([]);
    const loading = ref(true);
    const error = ref(null);
    const selectedTicket = ref(null);
    const transitioning = ref(false);
    const transitionError = ref(null);
    const showRejected = ref(false);
    const commentText = ref("");
    const submittingComment = ref(false);
    const commentError = ref(null);
    const showNewTicketModal = ref(false);
    const creating = ref(false);
    const createError = ref(null);
    const newTicket = ref({ title: "", priority: "MED", type: "task" });
    let sseSource = null;
    const columns = [
      { status: "new", label: "New (Idea)", color: "#6b7280" },
      { status: "approved", label: "Approved", color: "#3b82f6" },
      { status: "in_progress", label: "In Progress", color: "#f59e0b" },
      { status: "review", label: "Review", color: "#8b5cf6" },
      { status: "done", label: "Done", color: "#10b981" }
    ];
    function ticketsByStatus(status) {
      return tickets.value.filter((t) => t.status === status);
    }
    function statusLabel(status) {
      const map = {
        new: "New",
        approved: "Approved",
        in_progress: "In Progress",
        review: "Review",
        done: "Done",
        rejected: "Rejected"
      };
      return map[status] ?? status;
    }
    function formatDate(iso) {
      if (!iso) return "—";
      try {
        return new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(iso));
      } catch {
        return iso;
      }
    }
    async function fetchTickets() {
      try {
        const res = await fetch("/api/tickets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tickets.value = await res.json();
      } catch (e) {
        error.value = e.message ?? "Failed to load tickets";
      } finally {
        loading.value = false;
      }
    }
    async function transition(newStatus) {
      if (!selectedTicket.value) return;
      transitioning.value = true;
      transitionError.value = null;
      try {
        const res = await fetch(`/api/tickets/${selectedTicket.value.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const updated = await res.json();
        const idx = tickets.value.findIndex((t) => t.id === updated.id);
        if (idx !== -1) tickets.value[idx] = updated;
        selectedTicket.value = updated;
      } catch (e) {
        transitionError.value = e.message ?? "Transition failed";
      } finally {
        transitioning.value = false;
      }
    }
    async function submitComment() {
      if (!selectedTicket.value || !commentText.value.trim()) return;
      submittingComment.value = true;
      commentError.value = null;
      try {
        const res = await fetch(`/api/tickets/${selectedTicket.value.id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: commentText.value.trim() })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        commentText.value = "";
      } catch (e) {
        commentError.value = e.message ?? "Failed to post comment";
      } finally {
        submittingComment.value = false;
      }
    }
    function openNewTicketModal() {
      newTicket.value = { title: "", priority: "MED", type: "task" };
      createError.value = null;
      showNewTicketModal.value = true;
    }
    async function createTicket() {
      if (!newTicket.value.title.trim()) return;
      creating.value = true;
      createError.value = null;
      try {
        const res = await fetch("/api/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: newTicket.value.title.trim(),
            priority: newTicket.value.priority,
            type: newTicket.value.type
          })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const created = await res.json();
        tickets.value.unshift(created);
        showNewTicketModal.value = false;
      } catch (e) {
        createError.value = e.message ?? "Failed to create ticket";
      } finally {
        creating.value = false;
      }
    }
    function connectSSE() {
      sseSource = new EventSource("/api/events");
      sseSource.addEventListener("ticket_created", (e) => {
        try {
          const ticket = JSON.parse(e.data);
          if (!tickets.value.find((t) => t.id === ticket.id)) {
            tickets.value.unshift(ticket);
          }
        } catch {
        }
      });
      sseSource.addEventListener("ticket_updated", (e) => {
        try {
          const ticket = JSON.parse(e.data);
          const idx = tickets.value.findIndex((t) => t.id === ticket.id);
          if (idx !== -1) {
            tickets.value[idx] = ticket;
            if (selectedTicket.value?.id === ticket.id) {
              selectedTicket.value = ticket;
            }
          } else {
            tickets.value.unshift(ticket);
          }
        } catch {
        }
      });
      sseSource.onerror = () => {
        setTimeout(() => {
          if (sseSource) {
            sseSource.close();
            connectSSE();
          }
        }, 5e3);
      };
    }
    function selectTicket(ticket) {
      selectedTicket.value = ticket;
      transitionError.value = null;
      commentText.value = "";
      commentError.value = null;
    }
    onMounted(() => {
      fetchTickets();
      connectSSE();
    });
    onUnmounted(() => {
      sseSource?.close();
      sseSource = null;
    });
    return (_ctx, _cache) => {
      return _openBlock(), _createElementBlock("div", _hoisted_1, [
        _createElementVNode("header", { class: "tickets-header" }, [
          _cache[20] || (_cache[20] = _createElementVNode("h1", { class: "tickets-title" }, "Tickets", -1)),
          _createElementVNode("button", {
            class: "btn-primary",
            onClick: openNewTicketModal
          }, "+ New Ticket")
        ]),
        loading.value ? (_openBlock(), _createElementBlock("div", _hoisted_2, "Loading tickets…")) : error.value ? (_openBlock(), _createElementBlock("div", _hoisted_3, _toDisplayString(error.value), 1)) : (_openBlock(), _createElementBlock("div", _hoisted_4, [
          _createElementVNode("div", _hoisted_5, [
            (_openBlock(), _createElementBlock(_Fragment, null, _renderList(columns, (col) => {
              return _createElementVNode("div", {
                key: col.status,
                class: "kanban-column"
              }, [
                _createElementVNode("div", {
                  class: "column-header",
                  style: _normalizeStyle({ borderTopColor: col.color })
                }, [
                  _createElementVNode("span", _hoisted_6, _toDisplayString(col.label), 1),
                  _createElementVNode("span", _hoisted_7, _toDisplayString(ticketsByStatus(col.status).length), 1)
                ], 4),
                _createElementVNode("div", _hoisted_8, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(ticketsByStatus(col.status), (ticket) => {
                    return _openBlock(), _createElementBlock("div", {
                      key: ticket.id,
                      class: _normalizeClass(["ticket-card", { selected: selectedTicket.value?.id === ticket.id }]),
                      onClick: ($event) => selectTicket(ticket)
                    }, [
                      _createElementVNode("div", _hoisted_10, [
                        _createElementVNode("span", {
                          class: _normalizeClass(["priority-badge", "priority-" + ticket.priority.toLowerCase()])
                        }, _toDisplayString(ticket.priority), 3),
                        _createElementVNode("span", _hoisted_11, "#" + _toDisplayString(ticket.id), 1)
                      ]),
                      _createElementVNode("div", _hoisted_12, _toDisplayString(ticket.title), 1),
                      ticket.assigned_to ? (_openBlock(), _createElementBlock("div", _hoisted_13, [
                        _cache[21] || (_cache[21] = _createElementVNode("span", { class: "assignee-icon" }, "👤", -1)),
                        _createTextVNode(" " + _toDisplayString(ticket.assigned_to), 1)
                      ])) : _createCommentVNode("", true)
                    ], 10, _hoisted_9);
                  }), 128)),
                  ticketsByStatus(col.status).length === 0 ? (_openBlock(), _createElementBlock("div", _hoisted_14, " No tickets ")) : _createCommentVNode("", true)
                ])
              ]);
            }), 64))
          ]),
          _createElementVNode("div", _hoisted_15, [
            _createElementVNode("button", {
              class: "rejected-toggle",
              onClick: _cache[0] || (_cache[0] = ($event) => showRejected.value = !showRejected.value)
            }, [
              _createElementVNode("span", null, "Rejected (" + _toDisplayString(ticketsByStatus("rejected").length) + ")", 1),
              _createElementVNode("span", null, _toDisplayString(showRejected.value ? "▲" : "▼"), 1)
            ]),
            showRejected.value ? (_openBlock(), _createElementBlock("div", _hoisted_16, [
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(ticketsByStatus("rejected"), (ticket) => {
                return _openBlock(), _createElementBlock("div", {
                  key: ticket.id,
                  class: _normalizeClass(["ticket-card rejected", { selected: selectedTicket.value?.id === ticket.id }]),
                  onClick: ($event) => selectTicket(ticket)
                }, [
                  _createElementVNode("div", _hoisted_18, [
                    _createElementVNode("span", {
                      class: _normalizeClass(["priority-badge", "priority-" + ticket.priority.toLowerCase()])
                    }, _toDisplayString(ticket.priority), 3),
                    _createElementVNode("span", _hoisted_19, "#" + _toDisplayString(ticket.id), 1)
                  ]),
                  _createElementVNode("div", _hoisted_20, _toDisplayString(ticket.title), 1)
                ], 10, _hoisted_17);
              }), 128)),
              ticketsByStatus("rejected").length === 0 ? (_openBlock(), _createElementBlock("div", _hoisted_21, "No rejected tickets")) : _createCommentVNode("", true)
            ])) : _createCommentVNode("", true)
          ])
        ])),
        _createVNode(_Transition, { name: "panel-slide" }, {
          default: _withCtx(() => [
            selectedTicket.value ? (_openBlock(), _createElementBlock("div", {
              key: 0,
              class: "detail-overlay",
              onClick: _cache[13] || (_cache[13] = _withModifiers(($event) => selectedTicket.value = null, ["self"]))
            }, [
              _createElementVNode("div", _hoisted_22, [
                _createElementVNode("button", {
                  class: "panel-close",
                  onClick: _cache[1] || (_cache[1] = ($event) => selectedTicket.value = null)
                }, "✕"),
                _createElementVNode("div", _hoisted_23, [
                  _createElementVNode("span", {
                    class: _normalizeClass(["priority-badge lg", "priority-" + selectedTicket.value.priority.toLowerCase()])
                  }, _toDisplayString(selectedTicket.value.priority), 3),
                  _createElementVNode("h2", _hoisted_24, _toDisplayString(selectedTicket.value.title), 1)
                ]),
                _createElementVNode("div", _hoisted_25, [
                  _createElementVNode("div", _hoisted_26, [
                    _cache[22] || (_cache[22] = _createElementVNode("span", { class: "meta-label" }, "ID", -1)),
                    _createElementVNode("span", _hoisted_27, "#" + _toDisplayString(selectedTicket.value.id), 1)
                  ]),
                  _createElementVNode("div", _hoisted_28, [
                    _cache[23] || (_cache[23] = _createElementVNode("span", { class: "meta-label" }, "Status", -1)),
                    _createElementVNode("span", {
                      class: _normalizeClass(["status-chip", "status-" + selectedTicket.value.status])
                    }, _toDisplayString(statusLabel(selectedTicket.value.status)), 3)
                  ]),
                  _createElementVNode("div", _hoisted_29, [
                    _cache[24] || (_cache[24] = _createElementVNode("span", { class: "meta-label" }, "Type", -1)),
                    _createElementVNode("span", _hoisted_30, _toDisplayString(selectedTicket.value.type || "—"), 1)
                  ]),
                  _createElementVNode("div", _hoisted_31, [
                    _cache[25] || (_cache[25] = _createElementVNode("span", { class: "meta-label" }, "Assignee", -1)),
                    _createElementVNode("span", _hoisted_32, _toDisplayString(selectedTicket.value.assigned_to || "Unassigned"), 1)
                  ]),
                  _createElementVNode("div", _hoisted_33, [
                    _cache[26] || (_cache[26] = _createElementVNode("span", { class: "meta-label" }, "Created", -1)),
                    _createElementVNode("span", _hoisted_34, _toDisplayString(formatDate(selectedTicket.value.created_at)), 1)
                  ])
                ]),
                _createElementVNode("div", _hoisted_35, [
                  _cache[27] || (_cache[27] = _createElementVNode("div", { class: "transitions-label" }, "Actions", -1)),
                  selectedTicket.value.status === "done" ? (_openBlock(), _createElementBlock("div", _hoisted_36, "✓ Completed")) : (_openBlock(), _createElementBlock("div", _hoisted_37, [
                    selectedTicket.value.status === "new" ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                      _createElementVNode("button", {
                        class: "btn-action approve",
                        onClick: _cache[2] || (_cache[2] = ($event) => transition("approved")),
                        disabled: transitioning.value
                      }, "Approve", 8, _hoisted_38),
                      _createElementVNode("button", {
                        class: "btn-action reject",
                        onClick: _cache[3] || (_cache[3] = ($event) => transition("rejected")),
                        disabled: transitioning.value
                      }, "Reject", 8, _hoisted_39)
                    ], 64)) : selectedTicket.value.status === "approved" ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                      _createElementVNode("button", {
                        class: "btn-action start",
                        onClick: _cache[4] || (_cache[4] = ($event) => transition("in_progress")),
                        disabled: transitioning.value
                      }, "Start Work", 8, _hoisted_40),
                      _createElementVNode("button", {
                        class: "btn-action reject",
                        onClick: _cache[5] || (_cache[5] = ($event) => transition("rejected")),
                        disabled: transitioning.value
                      }, "Reject", 8, _hoisted_41)
                    ], 64)) : selectedTicket.value.status === "in_progress" ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                      _createElementVNode("button", {
                        class: "btn-action review",
                        onClick: _cache[6] || (_cache[6] = ($event) => transition("review")),
                        disabled: transitioning.value
                      }, "Send to Review", 8, _hoisted_42),
                      _createElementVNode("button", {
                        class: "btn-action reject",
                        onClick: _cache[7] || (_cache[7] = ($event) => transition("rejected")),
                        disabled: transitioning.value
                      }, "Reject", 8, _hoisted_43)
                    ], 64)) : selectedTicket.value.status === "review" ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                      _createElementVNode("button", {
                        class: "btn-action done",
                        onClick: _cache[8] || (_cache[8] = ($event) => transition("done")),
                        disabled: transitioning.value
                      }, "Mark Done", 8, _hoisted_44),
                      _createElementVNode("button", {
                        class: "btn-action back",
                        onClick: _cache[9] || (_cache[9] = ($event) => transition("in_progress")),
                        disabled: transitioning.value
                      }, "Back to In Progress", 8, _hoisted_45),
                      _createElementVNode("button", {
                        class: "btn-action reject",
                        onClick: _cache[10] || (_cache[10] = ($event) => transition("rejected")),
                        disabled: transitioning.value
                      }, "Reject", 8, _hoisted_46)
                    ], 64)) : selectedTicket.value.status === "rejected" ? (_openBlock(), _createElementBlock("button", {
                      key: 4,
                      class: "btn-action reopen",
                      onClick: _cache[11] || (_cache[11] = ($event) => transition("new")),
                      disabled: transitioning.value
                    }, "Reopen", 8, _hoisted_47)) : _createCommentVNode("", true)
                  ])),
                  transitionError.value ? (_openBlock(), _createElementBlock("div", _hoisted_48, _toDisplayString(transitionError.value), 1)) : _createCommentVNode("", true)
                ]),
                _createElementVNode("div", _hoisted_49, [
                  _cache[28] || (_cache[28] = _createElementVNode("div", { class: "transitions-label" }, "Add Comment", -1)),
                  _withDirectives(_createElementVNode("textarea", {
                    "onUpdate:modelValue": _cache[12] || (_cache[12] = ($event) => commentText.value = $event),
                    class: "comment-input",
                    placeholder: "Write a comment…",
                    rows: "3"
                  }, null, 512), [
                    [_vModelText, commentText.value]
                  ]),
                  _createElementVNode("button", {
                    class: "btn-primary sm",
                    onClick: submitComment,
                    disabled: !commentText.value.trim() || submittingComment.value
                  }, _toDisplayString(submittingComment.value ? "Posting…" : "Post Comment"), 9, _hoisted_50),
                  commentError.value ? (_openBlock(), _createElementBlock("div", _hoisted_51, _toDisplayString(commentError.value), 1)) : _createCommentVNode("", true)
                ])
              ])
            ])) : _createCommentVNode("", true)
          ]),
          _: 1
        }),
        _createVNode(_Transition, { name: "fade" }, {
          default: _withCtx(() => [
            showNewTicketModal.value ? (_openBlock(), _createElementBlock("div", {
              key: 0,
              class: "modal-overlay",
              onClick: _cache[19] || (_cache[19] = _withModifiers(($event) => showNewTicketModal.value = false, ["self"]))
            }, [
              _createElementVNode("div", _hoisted_52, [
                _createElementVNode("div", _hoisted_53, [
                  _cache[29] || (_cache[29] = _createElementVNode("h3", null, "New Ticket", -1)),
                  _createElementVNode("button", {
                    class: "panel-close",
                    onClick: _cache[14] || (_cache[14] = ($event) => showNewTicketModal.value = false)
                  }, "✕")
                ]),
                _createElementVNode("form", {
                  onSubmit: _withModifiers(createTicket, ["prevent"]),
                  class: "ticket-form"
                }, [
                  _createElementVNode("div", _hoisted_54, [
                    _cache[30] || (_cache[30] = _createElementVNode("label", null, [
                      _createTextVNode("Title "),
                      _createElementVNode("span", { class: "required" }, "*")
                    ], -1)),
                    _withDirectives(_createElementVNode("input", {
                      "onUpdate:modelValue": _cache[15] || (_cache[15] = ($event) => newTicket.value.title = $event),
                      type: "text",
                      class: "form-input",
                      placeholder: "Describe the ticket…",
                      autofocus: ""
                    }, null, 512), [
                      [_vModelText, newTicket.value.title]
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_55, [
                    _cache[32] || (_cache[32] = _createElementVNode("label", null, "Priority", -1)),
                    _withDirectives(_createElementVNode("select", {
                      "onUpdate:modelValue": _cache[16] || (_cache[16] = ($event) => newTicket.value.priority = $event),
                      class: "form-select"
                    }, [..._cache[31] || (_cache[31] = [
                      _createElementVNode("option", { value: "LOW" }, "LOW", -1),
                      _createElementVNode("option", { value: "MED" }, "MED", -1),
                      _createElementVNode("option", { value: "HIGH" }, "HIGH", -1),
                      _createElementVNode("option", { value: "CRITICAL" }, "CRITICAL", -1)
                    ])], 512), [
                      [_vModelSelect, newTicket.value.priority]
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_56, [
                    _cache[34] || (_cache[34] = _createElementVNode("label", null, "Type", -1)),
                    _withDirectives(_createElementVNode("select", {
                      "onUpdate:modelValue": _cache[17] || (_cache[17] = ($event) => newTicket.value.type = $event),
                      class: "form-select"
                    }, [..._cache[33] || (_cache[33] = [
                      _createElementVNode("option", { value: "feature" }, "Feature", -1),
                      _createElementVNode("option", { value: "bug" }, "Bug", -1),
                      _createElementVNode("option", { value: "task" }, "Task", -1),
                      _createElementVNode("option", { value: "improvement" }, "Improvement", -1)
                    ])], 512), [
                      [_vModelSelect, newTicket.value.type]
                    ])
                  ]),
                  createError.value ? (_openBlock(), _createElementBlock("div", _hoisted_57, _toDisplayString(createError.value), 1)) : _createCommentVNode("", true),
                  _createElementVNode("div", _hoisted_58, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn-secondary",
                      onClick: _cache[18] || (_cache[18] = ($event) => showNewTicketModal.value = false)
                    }, "Cancel"),
                    _createElementVNode("button", {
                      type: "submit",
                      class: "btn-primary",
                      disabled: !newTicket.value.title.trim() || creating.value
                    }, _toDisplayString(creating.value ? "Creating…" : "Create Ticket"), 9, _hoisted_59)
                  ])
                ], 32)
              ])
            ])) : _createCommentVNode("", true)
          ]),
          _: 1
        })
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

const TicketsView = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-34e754ef"]]);

export { TicketsView as default };
