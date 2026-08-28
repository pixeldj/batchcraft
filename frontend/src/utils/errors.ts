import { ApiError } from "../api/client";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code === "network_error" ? `Network error: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : "An unexpected error occurred";
}
