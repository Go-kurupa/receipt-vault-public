export class ManageError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'revoked' | 'duplicate_label', message: string) {
    super(message);
  }
}
