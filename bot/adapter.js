
import 'dotenv/config';
import { BotFrameworkAdapter } from 'botbuilder';

export const adapter = new BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword
});

console.log("AppId:", process.env.MicrosoftAppId);
console.log("Password vorhanden:", !!process.env.MicrosoftAppPassword);