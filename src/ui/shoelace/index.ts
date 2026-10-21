// Shoelace-styled web components for the joining service auth flow.
// Import this module to register all custom elements.
// Requires @shoelace-style/shoelace as a peer dependency.

export { JoiningClaimsFormSl } from './joining-claims-form-sl.js';
export { JoiningChallengeDialogSl } from './joining-challenge-dialog-sl.js';
export { JoiningStatusSl } from './joining-status-sl.js';
export { JoiningFlowSl } from './joining-flow-sl.js';

// Re-export event detail types from headless components
export type { ClaimsSubmittedDetail } from '../joining-claims-form.js';
export type { ChallengeResponseDetail } from '../joining-challenge-dialog.js';
export type { ChallengeResendDetail } from '../link-challenge.js';
export type { JoiningStatusValue } from '../joining-status.js';
export type { JoinCompleteDetail, JoinErrorDetail } from '../joining-flow.js';
