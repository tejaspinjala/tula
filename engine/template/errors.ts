export class TemplateError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(details.length ? `${message}\n  - ${details.join('\n  - ')}` : message);
    this.name = 'TemplateError';
  }
}
