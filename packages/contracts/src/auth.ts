export interface RegistrationRequest {
  email: string;
  password: string;
  displayName: string;
}

export type RegistrationField = keyof RegistrationRequest;
export type FieldErrors = Partial<Record<RegistrationField, string>>;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface RegistrationResponse { user: PublicUser }
export interface CsrfResponse { csrfToken: string }
