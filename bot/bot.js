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
import { getStrictSemanticAnswerString } from '../services/cognitiveSearch.js';
const systemPrompt = fs.readFileSync(path.resolve(__dirname, '../config/system_prompt.txt'), 'utf8');

class MyBot extends ActivityHandler {
    constructor() {
        super();
        this.onMessage(async (context, next) => {
            try {
                let userText = context.activity.text || '';
                console.log("💬 Eingehende Nachricht:", {
                  from: context.activity.from.name,
                  text: userText,
                  timestamp: context.activity.timestamp
                });
                const sessionId = context.activity.conversation.id;
                const userName = context.activity.from.name;
                const { imageUrls, fileNotices } = await extractImagesFromContext(context);
                const safeImages = (imageUrls || []).filter(u =>
                  typeof u === 'string' && (u.startsWith('https://') || /^data:image\/(png|jpeg);base64,/.test(u))
                ).slice(0, 4);
                if (fileNotices.length > 0) {
                    userText += ' \n ' + fileNotices.join(', ');
                }
                await context.sendActivity({ type: 'typing' });
                await saveOrUpdateReference(context);
                getStrictSemanticAnswerString(userText, sessionId).catch(err => {
                  console.error('RAG error:', err && (err.stack || err));
                });


                const [response] = await Promise.all([
                    getChatCompletion({
                        sessionId,
                        role: 'user',
                        text: userText,
                        userName,
                        imageUrls: safeImages
                    }),
                    new Promise(resolve => setTimeout(resolve, 100))
                ]);

                const { reply, functionCall } = response;

                if (reply && reply.trim() !== '') {
                    await context.sendActivity(MessageFactory.text(reply));
                }

                if (functionCall) {
                    let args = {};
                    try {
                      args = typeof functionCall.arguments === 'string'
                        ? JSON.parse(functionCall.arguments || '{}')
                        : (functionCall.arguments || {});
                    } catch (e) {
                      console.warn('⚠️ Konnte functionCall.arguments nicht parsen:', functionCall.arguments);
                    }

                    let typingActive = true;
                    const endAt = Date.now() + 40000; // 40s safety cap
                    const typingLoop = async () => {
                      while (typingActive && Date.now() < endAt) {
                        try {
                          await context.sendActivity({ type: 'typing' });
                        } catch (err) {
                          console.error('❌ Fehler beim Senden des "typing"-Events:', err && (err.message || err));
                          break;
                        }
                        await new Promise(res => setTimeout(res, 1000));
                      }
                    };
                    const typingTask = typingLoop();

                    let functionReply;
                    try {
                      const [functionModule] = await Promise.all([
                        import(`../functions/${functionCall.name}.js`),
                        new Promise(resolve => setTimeout(resolve, 300))
                      ]);

                      functionReply = await functionModule.default(sessionId, userName, args);
                    } catch (e) {
                      console.error(`❌ Funktionsaufruf "${functionCall.name}" fehlgeschlagen:`, e && (e.stack || e));
                      await context.sendActivity(`⚠️ Funktion "${functionCall.name}" ist momentan nicht verfügbar.`);
                    } finally {
                      typingActive = false;
                      await typingTask;
                    }

                    if (functionReply) {
                      await context.sendActivity(MessageFactory.text(functionReply));
                    }
                }

            } catch (error) {
                console.error("❌ Fehler in onMessage (full):", error && (error.stack || error));
                if (error?.status === 400 && String(error.message || '').includes("filtered due to the prompt triggering")) {
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