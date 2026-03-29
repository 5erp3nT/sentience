import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Settings as SettingsIcon, Send, MessageSquare, Copy, Check, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Settings from './Settings';

const WS_URL = `ws://localhost:8345/v1/realtime`;

const CodeBlock = ({ language, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-container">
      <div className="code-header">
        <span>{language || 'code'}</span>
        <button className="copy-btn" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{ margin: 0, padding: '12px' }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
};

const MessageContent = ({ content }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="prose"
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';
          return !inline ? (
            <CodeBlock language={language} value={String(children).replace(/\n$/, '')} />
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

const App = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [interimUserText, setInterimUserText] = useState('');
  const [interimAiText, setInterimAiText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [attachments, setAttachments] = useState([]); // {id, name, type, data, preview}
  const [showSettings, setShowSettings] = useState(false);
  const [currentModel, setCurrentModel] = useState({ id: '', reason: '' });


  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);



  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const currentAudioElementRef = useRef(null);

  const interruptAudio = () => {
    audioQueueRef.current = []; // Clear pending audio
    if (currentAudioElementRef.current) {
      try {
        currentAudioElementRef.current.pause();
        currentAudioElementRef.current.currentTime = 0;
      } catch (e) {}
      currentAudioElementRef.current = null;
    }
    isPlayingRef.current = false;
  };

  const playNextAudio = () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const base64Audio = audioQueueRef.current.shift();
    const audio = new window.Audio("data:audio/wav;base64," + base64Audio);
    currentAudioElementRef.current = audio;
    audio.onended = playNextAudio;
    audio.play().catch(e => {
      console.error("Audio playback error:", e);
      playNextAudio();
    });
  };

  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    onOpen: () => {
      sendJsonMessage({ type: 'session.update', session: { modalities: ['text', 'audio'], client_type: 'voice' } });
    },
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, interimUserText, interimAiText]);


  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [textInput]);


  useEffect(() => {
    if (lastJsonMessage) {
      const { type, delta, text } = lastJsonMessage;

      if (type === 'response.audio_transcript.delta') {
        setInterimUserText(delta);
      } else if (type === 'response.audio_transcript.done') {
        if (text || interimUserText) {
          setMessages(prev => [...prev, { role: 'user', content: text || interimUserText }]);
          setInterimUserText('');
        }
      } else if (type === 'response.history') {
        setMessages(lastJsonMessage.messages || []);
      } else if (type === 'response.ai_text.delta') {
        setInterimAiText(prev => prev + delta);
      } else if (type === 'response.ai_text.done') {
        const finalContent = text || interimAiText;
        if (finalContent) {
          setMessages(prev => [...prev, { role: 'assistant', content: finalContent }]);
          setInterimAiText('');
        }
      } else if (type === 'control.recording.start') {
        startRecording();
      } else if (type === 'control.recording.stop') {
        stopRecording();
      } else if (type === 'response.audio.done') {
        audioQueueRef.current.push(lastJsonMessage.audio);
        if (!isPlayingRef.current) {
          playNextAudio();
        }
      } else if (type === 'response.model_switch') {
        setCurrentModel({ id: lastJsonMessage.model, reason: lastJsonMessage.reason });
      }
    }
  }, [lastJsonMessage]);

  const handleSendText = () => {
    interruptAudio();
    if (!textInput.trim() && attachments.length === 0) return;
    
    // Optimistic UI: add message to list
    const content = textInput.trim();
    setMessages(prev => [...prev, { 
      role: 'user', 
      content: content || (attachments.length > 0 ? "[Attached Files]" : ""),
      attachments: attachments.map(a => ({ name: a.name, type: a.type })) // Just for UI record
    }]);

    sendJsonMessage({ 
      type: 'input_text', 
      text: content,
      attachments: attachments.map(a => ({
        name: a.name,
        type: a.type,
        data: a.data.split(',')[1] // Send raw base64 without prefix
      }))
    });

    setTextInput('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handlePaste = async (e) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64Data = event.target.result;
          setAttachments(prev => [...prev, {
            id: Math.random().toString(36).substr(2, 9),
            name: `Pasted Image ${new Date().toLocaleTimeString()}`,
            type: file.type || 'image/png', // Default to png if type is empty from clipboard
            data: base64Data,
            preview: base64Data
          }]);

        };
        reader.readAsDataURL(file);
      }
    }
  };


  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        alert(`File ${file.name} is too large (> 10MB)`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64Data = event.target.result;
        const isImage = file.type.startsWith('image/');
        
        setAttachments(prev => [...prev, {
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          type: file.type,
          data: base64Data,
          preview: isImage ? base64Data : null
        }]);
      };
      reader.readAsDataURL(file);
    }
    // Reset input so same file can be picked again
    e.target.value = '';
  };

  const removeAttachment = (id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };


  const startRecording = async () => {
    interruptAudio();
    if (isRecording || streamRef.current) {
      console.log("DEBUG: Cleaning up existing microphone stream to prevent overlap leak.");
      stopRecording();
    }
    try {
      console.log("DEBUG: Attempting to start recording...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      // Force resume for backgrounded tabs
      if (audioContext.state === 'suspended') await audioContext.resume();
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule('/audio-processor.js');
      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
      
      workletNode.port.onmessage = (event) => {
        const pcmData = convertFloat32To16BitPCM(event.data);
        const base64Audio = arrayBufferToBase64(pcmData.buffer);
        sendJsonMessage({ type: 'input_audio_buffer.append', audio: base64Audio });
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination);
      workletNodeRef.current = workletNode;
      setIsRecording(true);
      sendJsonMessage({ type: "ui.recording.active" });
      console.log("DEBUG: Recording started successfully.");
    } catch (err) {
      console.error('Mic error:', err);
    }
  };

  const stopRecording = () => {
    console.log("DEBUG: Stopping recording...");
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsRecording(false);
    sendJsonMessage({ type: 'input_audio_buffer.commit' });
  };

  const convertFloat32To16BitPCM = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Int16Array(buffer);
  };

  const arrayBufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  };

  const isConnected = readyState === ReadyState.OPEN;

  return (
    <div className="widget-container">
      <header className="widget-header drag-region">
        <div className="status-indicator">
          <div className={`dot ${isConnected ? 'online' : 'offline'}`} />
          <span>{isConnected ? 'Sentience Online' : 'Reconnecting...'}</span>
          {currentModel.id && (
            <div className={`model-badge-mini ${currentModel.reason}`}>
              {currentModel.reason === 'screenshot' ? '👁️' : 
               currentModel.reason === 'heavy_thinker' ? '🧠' : '✨'} 
              {currentModel.id.split('/').pop()}
            </div>
          )}
        </div>
        <button className="icon-btn no-drag" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={18} />
        </button>
      </header>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}

      <div className="messages-area">
        {isRecording && (
          <div className="recording-overlay">
            <div className="recording-pulse"></div>
            <span>SENTIENCE HEARING...</span>
          </div>
        )}
        {messages.length === 0 && !interimUserText && !interimAiText && !isRecording && (
          <div className="empty-state">
            <MessageSquare size={32} opacity={0.3} />
            <p>Ready for Alt + \ command</p>
          </div>
        )}
        
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <MessageContent content={msg.content} />
          </div>
        ))}
        
        {interimUserText && (
          <div className="message user interim">
            <p>{interimUserText}</p>
          </div>
        )}
        
        {interimAiText && (
          <div className="message assistant interim">
            <MessageContent content={interimAiText} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area-wrapper">
        {attachments.length > 0 && (
          <div className="attachment-preview-area">
            {attachments.map(at => (
              <div key={at.id} className="attachment-chip">
                {at.preview ? (
                  <img src={at.preview} alt="preview" className="chip-thumb" />
                ) : (
                  <FileText size={14} className="chip-icon" />
                )}
                <span className="chip-name">{at.name}</span>
                <button className="chip-remove" onClick={() => removeAttachment(at.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="input-area">
          <input 
            type="file" 
            ref={fileInputRef} 
            style={{ display: 'none' }} 
            onChange={handleFileSelect}
            multiple
            accept="image/*,application/pdf,text/plain"
          />
          <button 
            className="icon-btn no-drag" 
            onClick={() => fileInputRef.current?.click()}
            title="Attach files or images"
          >
            <Paperclip size={20} />
          </button>
          
          <textarea 
            ref={textareaRef}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendText();
              }
            }}
            onPaste={handlePaste}
            placeholder="Type or speak..."
            disabled={!isConnected}
            rows={1}
          />
          
          {(textInput.trim() || attachments.length > 0) ? (
            <button className="send-btn" onClick={handleSendText} style={{ marginBottom: '4px' }}>
              <Send size={18} />
            </button>
          ) : (
            <button 
              className={`mic-btn ${isRecording ? 'recording' : ''}`}
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onMouseLeave={isRecording ? stopRecording : undefined}
              disabled={!isConnected}
              title="Hold to speak"
              style={{ marginBottom: '4px' }}
            >
              {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}

        </div>
      </div>

    </div>
  );
};

export default App;
