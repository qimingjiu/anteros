export const INCOMING_FILE_STAGES = ["selection","authorization","queue","resolve","download","parse","cache"] as const;
export type IncomingFileStage = typeof INCOMING_FILE_STAGES[number];
export const INCOMING_FILE_REASONS = ["forbidden","invalid_input","not_found","not_authorized","unsupported","too_large","busy",
  "invalid_cache","read_failed","protocol_unavailable","download_failed","download_timeout","download_rejected","parse_failed","parse_timeout"] as const;
export type IncomingFileReason = typeof INCOMING_FILE_REASONS[number];

/** A finite stage/reason and a fixed description, without upstream URLs, paths or payloads. */
export class IncomingFileError extends Error {
  constructor(readonly stage:IncomingFileStage,readonly reason:IncomingFileReason,message:string,readonly httpStatus?:number) {
    super(message);this.name="IncomingFileError";
  }
}
