import { BadRequestException } from '@nestjs/common';
import type { FieldErrors } from '@real-time-chat/contracts/auth';

export class ValidationError extends BadRequestException {
  constructor(readonly fieldErrors: FieldErrors) { super(); }
}
