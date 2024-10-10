import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, MessageCircle, Mic, Send } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';

import './ConsolePage.scss';
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

// Add this new interface for the email marketing content
interface EmailMarketingContent {
  subject: string;
  body: string;
}

// Add this type to handle the conversation item structure
type ConversationItemType = {
  id: string;
  role?: 'user' | 'assistant' | 'system';
  type?: string;
  formatted?: {
    transcript?: string;
    text?: string;
  };
};

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ConversationItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});

  // Add this new state variable for email marketing content
  const [emailContent, setEmailContent] = useState<EmailMarketingContent>({
    subject: '',
    body: '',
  });

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isVADMode, setIsVADMode] = useState(false);
  const [textMessage, setTextMessage] = useState('');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingTimer = useRef<NodeJS.Timeout | null>(null);

  const [vadEnabled, setVadEnabled] = useState(false);

  // Add this new state variable
  const [isListening, setIsListening] = useState(false);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setIsChatOpen(false); // Close the chat window when disconnecting

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  /**
   * Connect to conversation:
   * WavRecorder takes speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    if (isConnected) {
      await disconnectConversation();
    } else {
      const client = clientRef.current;
      const wavRecorder = wavRecorderRef.current;
      const wavStreamPlayer = wavStreamPlayerRef.current;

      // Set state variables
      startTimeRef.current = new Date().toISOString();
      setIsConnected(true);
      setRealtimeEvents([]);
      setItems(client.conversation.getItems());
      setIsChatOpen(true);

      // Connect to microphone
      await wavRecorder.begin();

      // Connect to audio output
      await wavStreamPlayer.connect();

      // Connect to realtime API
      await client.connect();
      client.sendUserMessageContent([
        {
          type: `input_text`,
          text: `Hello!`,
        },
      ]);

      // Default to push-to-talk mode
      client.updateSession({ turn_detection: null });
    }
  }, [isConnected, disconnectConversation]);

  /**
   * Change between Manual <> VAD mode for communication
   */
  const changeTurnEndType = useCallback(async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    setIsVADMode(value === 'server_vad');
    
    // Start listening immediately when switching to VAD mode
    if (value === 'server_vad' && client.isConnected()) {
      setIsListening(true);
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    } else {
      setIsListening(false);
      await wavRecorder.pause();
    }
  }, []);

  // Add this new function to toggle listening in VAD mode
  const toggleListening = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;

    if (isListening) {
      setIsListening(false);
      await wavRecorder.pause();
      client.createResponse();
    } else {
      setIsListening(true);
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, [isListening]);

  /**
   * In push-to-talk mode, stop recording
   */
  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  }, []);

  const stopPlayback = useCallback(async () => {
    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const handlePushToTalk = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isConnected || isVADMode) return;

    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;

    if (!isRecording) {
      await stopPlayback(); // Stop playback when starting push-to-talk
      setIsRecording(true);
      setRecordingDuration(0);
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
      recordingTimer.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    }
  }, [isConnected, isVADMode, isRecording, stopPlayback]);

  const handlePushToTalkEnd = useCallback(async () => {
    if (isRecording) {
      await stopRecording();
      if (recordingTimer.current) {
        clearInterval(recordingTimer.current);
      }
    }
  }, [isRecording, stopRecording]);

  const sendTextMessage = useCallback(async () => {
    if (!isConnected || !textMessage.trim()) return;

    await stopPlayback(); // Stop playback when sending a text message

    const client = clientRef.current;
    client.sendUserMessageContent([
      {
        type: 'input_text',
        text: textMessage,
      },
    ]);
    setTextMessage('');
  }, [isConnected, textMessage, stopPlayback]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendTextMessage();
    }
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: instructions });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // Add tools
    client.addTool(
      {
        name: 'set_memory',
        description: 'Saves important data about the user into memory.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description:
                'The key of the memory value. Always use lowercase and underscores, no other characters.',
            },
            value: {
              type: 'string',
              description: 'Value can be anything represented as a string',
            },
          },
          required: ['key', 'value'],
        },
      },
      async ({ key, value }: { [key: string]: any }) => {
        setMemoryKv((memoryKv) => {
          const newKv = { ...memoryKv };
          newKv[key] = value;
          return newKv;
        });
        return { ok: true };
      }
    );
    client.addTool(
      {
        name: 'edit_email_marketing',
        description: 'Edits the email marketing content for a restaurant.',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              description: 'The subject line of the email',
            },
            body: {
              type: 'string',
              description: 'The main content of the email',
            },
          },
          required: ['subject', 'body'],
        },
      },
      async ({ subject, body }: EmailMarketingContent) => {
        setEmailContent({ subject, body });
        return { success: true, message: 'Email content updated successfully' };
      }
    );

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-main">
        <div className="content-left">
          <div className="content-block email-marketing">
            <div className="content-block-title">Email Marketing Content</div>
            <div className="content-block-body">
              <h3>Email Subject:</h3>
              <textarea
                value={emailContent.subject}
                onChange={(e) => setEmailContent(prev => ({ ...prev, subject: e.target.value }))}
              />
              <h3>Email Body:</h3>
              <textarea
                value={emailContent.body}
                onChange={(e) => setEmailContent(prev => ({ ...prev, body: e.target.value }))}
              />
            </div>
          </div>
        </div>
      </div>
      <div className={`chat-popup ${isChatOpen ? 'open' : ''} ${isVADMode ? 'vad-mode' : ''}`}>
        <div className="chat-header">
          <span>Assistant</span>
          <Toggle
            defaultValue={false}
            labels={['text', 'call']}
            values={['none', 'server_vad']}
            onChange={(_, value) => changeTurnEndType(value)}
          />
          <Button
            icon={X}
            buttonStyle="flush"
            onClick={() => setIsChatOpen(false)}
          />
        </div>
        <div className="chat-body" data-conversation-content>
          {!items.length && (
            <div className="chat-welcome">
              Welcome! How can I assist you today?
            </div>
          )}
          {items.map((conversationItem, i) => {
            if (!conversationItem.formatted?.transcript && !conversationItem.formatted?.text) {
              return null; // Skip empty messages
            }
            return (
              <div className={`chat-message ${conversationItem.role || ''}`} key={conversationItem.id}>
                <div className="message-content">
                  {conversationItem.formatted?.transcript ||
                    conversationItem.formatted?.text ||
                    '(item sent)'}
                </div>
              </div>
            );
          })}
        </div>
        {isVADMode && (
          <div className="vad-controls">
            <div className={`call-status`}>
             {'Call is live...'}
            </div>
          </div>
        )}
        {!isVADMode && (
          <div className="chat-input">
            <textarea
              value={textMessage}
              onChange={(e) => setTextMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message"
            />
            <div className="button-group">
              <button
                className={`push-to-talk-button ${isRecording ? 'recording' : ''}`}
                onMouseDown={handlePushToTalk}
                onMouseUp={handlePushToTalkEnd}
                onMouseLeave={handlePushToTalkEnd}
              >
                <Mic />
                {isRecording && <span className="recording-duration">{recordingDuration}s</span>}
              </button>
              <Button
                icon={Send}
                buttonStyle="action"
                onClick={sendTextMessage}
              />
            </div>
          </div>
        )}
      </div>
      <div className="floating-button">
        <Button
          icon={isConnected ? X : MessageCircle}
          buttonStyle={isConnected ? 'alert' : 'action'}
          onClick={connectConversation}
        />
      </div>
    </div>
  );
}