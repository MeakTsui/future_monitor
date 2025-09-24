import logger from "../../logger.js";

export default async function sendConsole({ text, payload }) {
  if (text) logger.info(text);
  if (payload) logger.info({ payload }, "console payload");
}
