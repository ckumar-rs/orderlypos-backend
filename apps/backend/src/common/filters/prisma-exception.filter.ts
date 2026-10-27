import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  Catch,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

// Converts Prisma's database errors into the same JSON error shape as every
// other thrown HttpException, instead of a bare 500 "Internal server error"
// leaking a raw stack trace to the client. Every unique-constraint violation
// in the app (duplicate table number, email, gift-card code, ...) used to
// crash the request this way — this is the global safety net for all of
// them, with a couple of fields worded specifically for a clearer message.
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const httpException = this.toHttpException(exception);
    const body = httpException.getResponse();
    response
      .status(httpException.getStatus())
      .json(
        typeof body === 'string'
          ? { statusCode: httpException.getStatus(), message: body }
          : body,
      );
  }

  private toHttpException(exception: unknown): HttpException {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return new ConflictException(this.uniqueConstraintMessage(exception));
        case 'P2025':
          return new NotFoundException(
            'That record no longer exists — it may have just been changed or removed by someone else.',
          );
        case 'P2003':
          return new BadRequestException(
            'This action references something that does not exist or was already removed.',
          );
        default:
          return new InternalServerErrorException(
            'Something went wrong. Please try again.',
          );
      }
    }
    return new BadRequestException('The request could not be processed.');
  }

  private uniqueConstraintMessage(
    exception: Prisma.PrismaClientKnownRequestError,
  ): string {
    const target = (exception.meta?.target as string[] | undefined) ?? [];

    if (target.includes('number') && target.includes('floorId')) {
      return 'That table number is already used on this floor. Choose a different number.';
    }
    if (target.includes('qrToken')) {
      return 'That QR code is already assigned to another table.';
    }
    if (target.includes('email')) {
      return 'That email address is already in use.';
    }
    if (target.includes('code')) {
      return 'That code is already in use.';
    }
    if (target.includes('name')) {
      return 'That name is already in use. Choose a different one.';
    }

    const fields = target.join(', ') || 'value';
    return `A record with this ${fields} already exists.`;
  }
}
