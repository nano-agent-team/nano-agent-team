/**
 * TypeScript declarations for Module Federation virtual modules.
 * These are resolved at runtime by vite-plugin-federation; the type
 * system needs to know about them to avoid TS2307 errors.
 */
declare module 'devTeamPlugin/TicketsView' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TicketsView: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default TicketsView
}

declare module 'settingsPlugin/SetupWizard' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SetupWizard: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default SetupWizard
}

declare module 'settingsPlugin/SettingsView' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SettingsView: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default SettingsView
}

declare module 'simpleChatPlugin/SimpleChatView' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SimpleChatView: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default SimpleChatView
}

declare module 'issueTrackerPlugin/TicketsView' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TicketsView: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default TicketsView
}

declare module 'observabilityPlugin/ObservabilityView' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ObservabilityView: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default ObservabilityView
}
