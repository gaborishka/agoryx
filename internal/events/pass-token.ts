export const PASS_RESPONSE_TOKEN = "::pass::";

export const isPassResponse = (text: string): boolean =>
  text.trim().toLowerCase() === PASS_RESPONSE_TOKEN;
