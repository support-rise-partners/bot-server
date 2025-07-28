import { extractImagesFromContext } from '../services/attachments.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { adapter } from './adapter.js';
import { saveOrUpdateReference } from '../services/conversationReferenceService.js';
import { TurnContext } from 'botbuilder';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { ActivityHandler, MessageFactory } from 'botbuilder';
import { getChatCompletion } from '../services/openai.js';
const systemPrompt = fs.readFileSync(path.resolve(__dirname, '../config/system_prompt.txt'), 'utf8');

class MyBot extends ActivityHandler {
    constructor() {
        super();
        this.onMessage(async (context, next) => {
            try {
                let userText = context.activity.text || '';
                const sessionId = context.activity.conversation.id;
                const userName = context.activity.from.name;
                const { imageUrls, fileNotices } = await extractImagesFromContext(context);
                if (fileNotices.length > 0) {
                    userText += '\n' + fileNotices.join('\n');
                }
                await saveOrUpdateReference(context);

                await context.sendActivities([
                    { type: 'typing' },
                    { type: 'delay', value: 1000 }
                ]);
                const { reply, functionCall } = await getChatCompletion({
                    sessionId,
                    role: 'user',
                    text: userText,
                    userName,
                    imageUrls
                });

                if (reply && reply.trim() !== '') {
                    await context.sendActivity(MessageFactory.text(reply));
                }

                if (functionCall) {
                    await context.sendActivities([
                        { type: 'typing' },
                        { type: 'delay', value: 500 }
                    ]);
                    const result = await import(`../functions/${functionCall.name}.js`);
                    const functionReply = await result.default(sessionId, functionCall.arguments);

                    if (functionReply) {
                        await context.sendActivity(MessageFactory.text(functionReply));
                    }
                }

            } catch (error) {
                console.error("❌ Fehler in onMessage:", error.message);
                if (error.status === 400 && error.message?.includes("filtered due to the prompt triggering")) {
                    await context.sendActivity("⚠️ Diese Anfrage wurde vom System blockiert. Bitte formuliere sie etwas anders.");
                } else {
                    await context.sendActivity("❗ Es ist ein Fehler aufgetreten. Bitte versuche es später erneut.");
                }
            }

            await next();
        });

        this.onMembersAdded(async (context, next) => {
            try {
                const sessionId = context.activity.conversation.id;

                const { reply } = await getChatCompletion({
                    sessionId,
                    role: 'system',
                    text: 'Stelle dich vor und sage, wobei du helfen kannst. Maximal 3 Sätze'
                });

                const conversationReference = TurnContext.getConversationReference(context.activity);
                console.log("👋 Neue Konversation erkannt. Speichere ConversationReference:", {
                    serviceUrl: context.activity.serviceUrl,
                    conversationId: context.activity.conversation.id,
                    userId: context.activity.from.id,
                    userName: context.activity.from.name
                });

                const membersAdded = context.activity.membersAdded;
                const welcomeText = reply;
                for (let member of membersAdded) {
                    if (member.id !== context.activity.recipient.id) {
                        await context.sendActivity(MessageFactory.text(welcomeText));
                    }
                }
            } catch (error) {
                console.error("❌ Fehler in onMembersAdded:", error.message);
            }

            await next();
        });
    }
}

export { MyBot };