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
