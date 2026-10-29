export type ApiErrorResponse = {
  ok?: false;
  error: string;
  /** A stable name for the case, where the client words it itself. */
  code?: string;
};

