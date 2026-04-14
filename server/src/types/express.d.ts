export {};

declare global {
  namespace Express {
    interface Request {
      importJobId?: string;
      importJobDir?: string;
    }
  }
}
