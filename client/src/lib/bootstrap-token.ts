let _token: string | null = null;
let _publicId: string | null = null;

export function setBootstrapToken(token: string | null, publicId?: string | null) {
  _token = token;
  if (publicId !== undefined) _publicId = publicId;
}

export function getBootstrapToken(): string | null {
  return _token;
}

export function getBootstrapPublicId(): string | null {
  return _publicId;
}

export function clearBootstrapToken() {
  _token = null;
  _publicId = null;
}
