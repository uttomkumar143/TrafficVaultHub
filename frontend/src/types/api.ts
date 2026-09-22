/**
 * Shared API envelope types (PRD §72).
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    request_id: string | null;
  };
}
