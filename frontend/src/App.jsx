import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Settings as SettingsIcon, Send, MessageSquare, Copy, Check, Paperclip, X, FileText, Image as ImageIcon, ZoomIn, ZoomOut, Maximize, RotateCcw, Info, ChevronLeft, ChevronRight, Scaling, Square, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, Thermometer, Wind, Droplets, Sunrise, Sunset } from 'lucide-react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
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
          {copied ? <Check size={16} /> : <Copy size={16} />}
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

const WeatherWidget = ({ data }) => {
  if (!data) return null;
  const { current, location } = data;
  if (!current) return <div className="weather-error">Invalid weather data</div>;

  const getIcon = (code) => {
    const c = parseInt(code);
    if (c === 113) return <Sun className="weather-icon-main sunny" size={52} />;
    if ([116, 119, 122].includes(c)) return <Cloud className="weather-icon-main cloudy" size={52} />;
    if ([176, 263, 266, 281, 293, 296, 299, 302, 305, 308, 311, 353, 356, 359].includes(c)) return <CloudRain className="weather-icon-main rainy" size={52} />;
    if ([200, 386, 389, 392, 395].includes(c)) return <CloudLightning className="weather-icon-main stormy" size={52} />;
    if ([179, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371].includes(c)) return <CloudSnow className="weather-icon-main snowy" size={52} />;
    return <Cloud className="weather-icon-main" size={52} />;
  };

  return (
    <div className="weather-widget-premium">
      <div className="weather-glass-card">
        <div className="weather-top">
          <div className="weather-loc">
            <h3>{location || 'Unknown Location'}</h3>
            <p className="weather-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
          </div>
          <div className="weather-main-stat">
            {getIcon(current.weatherCode)}
            <div className="weather-temp-group">
              <span className="weather-temp-value">{current.temp_F}°</span>
              <span className="weather-cond">{current.weatherDesc?.[0]?.value || 'Condition Unknown'}</span>
            </div>
          </div>
        </div>
        
        <div className="weather-details-row">
          <div className="weather-stat-box">
            <Thermometer size={16} className="stat-icon" />
            <div className="stat-label">Feels Like</div>
            <div className="stat-value">{current.FeelsLikeF}°F</div>
          </div>
          <div className="weather-stat-box">
            <Wind size={16} className="stat-icon" />
            <div className="stat-label">Wind speed</div>
            <div className="stat-value">{current.windspeedMiles} mph</div>
          </div>
          <div className="weather-stat-box">
            <Droplets size={16} className="stat-icon" />
            <div className="stat-label">Humidity</div>
            <div className="stat-value">{current.humidity}%</div>
          </div>
        </div>

        {data.weather && data.weather.length > 0 && (
          <div className="weather-forecast-section">
            <h4 className="forecast-title">3-Day Forecast</h4>
            <div className="weather-forecast-grid">
              {data.weather.slice(0, 3).map((day, idx) => {
                const hourlyData = day.hourly?.[4] || day.hourly?.[0] || {};
                return (
                  <div key={idx} className="forecast-day-card">
                    <span className="fc-date">{idx === 0 ? 'Today' : new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</span>
                    <div className="fc-icon-wrap">
                      {parseInt(hourlyData.weatherCode) === 113 ? <Sun size={24} className="sunny" /> :
                       [116, 119, 122].includes(parseInt(hourlyData.weatherCode)) ? <Cloud size={24} className="cloudy" /> :
                       <CloudRain size={24} className="rainy" />}
                    </div>
                    <div className="fc-temps">
                      <span className="fc-max">{day.maxtempF}°</span>
                      <span className="fc-min">{day.mintempF}°</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.weather?.[0]?.astronomy?.[0] && (
          <div className="weather-footer">
            <div className="weather-stat-box">
              <Sunrise size={16} className="stat-icon" />
              <div className="stat-value">{data.weather[0].astronomy[0].sunrise}</div>
            </div>
            <div className="weather-stat-box">
              <Sunset size={16} className="stat-icon" />
              <div className="stat-value">{data.weather[0].astronomy[0].sunset}</div>
            </div>
            <div className="weather-stat-box">
              <Info size={16} className="stat-icon" />
              <div className="stat-value">UV {current.uvIndex}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ImageModal = ({ images, initialIndex = 0, onClose }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const imgRef = useRef(null);

  const currentImage = images[currentIndex];

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(scale * delta, 0.5), 10);
    setScale(newScale);
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Only left click
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const zoomToFit = (e) => {
    if (e) e.stopPropagation();
    if (!imgRef.current) return;
    const { naturalWidth, naturalHeight } = imgRef.current;
    if (!naturalWidth) return;
    
    // Fit should fill the viewport with margins
    const scaleX = (window.innerWidth * 0.9) / naturalWidth;
    const scaleY = (window.innerHeight * 0.9) / naturalHeight;
    const fitScale = Math.min(scaleX, scaleY);
    
    setScale(fitScale);
    setPosition({ x: 0, y: 0 });
  };

  const zoomToActual = (e) => {
    if (e) e.stopPropagation();
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const resetTransform = (e) => {
    if (e) e.stopPropagation();
    zoomToFit();
  };

  const zoomIn = (e) => {
    e.stopPropagation();
    setScale(prev => Math.min(prev * 1.2, 10));
  };

  const zoomOut = (e) => {
    e.stopPropagation();
    setScale(prev => Math.max(prev / 1.2, 0.1));
  };

  const handleNext = (e) => {
    if (e) e.stopPropagation();
    if (currentIndex < images.length - 1) {
      setCurrentIndex(prev => prev + 1);
      resetTransform();
    }
  };

  const handlePrev = (e) => {
    if (e) e.stopPropagation();
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      resetTransform();
    }
  };

  // Close on Escape, Navigate on Arrows
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') handleNext();
      if (e.key === 'ArrowLeft') handlePrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIndex]);

  if (!currentImage) return null;

  return (
    <div className="image-modal-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="image-modal-controls no-drag">
        <div className="index-counter-lite">{currentIndex + 1} / {images.length}</div>
        <div className="control-divider" />
        <button className="control-btn" onClick={zoomIn} title="Zoom In"><ZoomIn size={22} /></button>
        <button className="control-btn" onClick={zoomOut} title="Zoom Out"><ZoomOut size={22} /></button>
        <div className="control-divider" />
        <button className="control-btn" onClick={zoomToFit} title="Zoom to Fit"><Scaling size={22} /></button>
        <button className="control-btn literal-icon" onClick={zoomToActual} title="1:1 Size">1:1</button>
        <button className="control-btn" onClick={resetTransform} title="Reset"><RotateCcw size={22} /></button>
        <div className="control-divider" />
        <button className="control-btn close" onClick={onClose} title="Close"><X size={22} /></button>
      </div>
      
      {images.length > 1 && (
        <>
          <button 
            className={`gallery-nav-btn prev ${currentIndex === 0 ? 'disabled' : ''}`}
            onClick={handlePrev}
            disabled={currentIndex === 0}
          >
            <ChevronLeft size={36} />
          </button>
          <button 
            className={`gallery-nav-btn next ${currentIndex === images.length - 1 ? 'disabled' : ''}`}
            onClick={handleNext}
            disabled={currentIndex === images.length - 1}
          >
            <ChevronRight size={36} />
          </button>
        </>
      )}

      <div 
        className="image-modal-container"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        ref={containerRef}
      >
        <img
          ref={imgRef}
          src={currentImage}
          alt="Preview"
          className="modal-image"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
            cursor: isDragging ? 'grabbing' : 'grab'
          }}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      </div>

      <div className="image-modal-hint">
        Use arrows to navigate, mouse wheel to zoom, drag to pan
      </div>
    </div>
  );
};



const MediaManagerModal = ({ onClose, onSelectImage }) => {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchImages = async () => {
      try {
        const resp = await fetch('http://localhost:8345/api/images/cache');
        if (resp.ok) {
          const data = await resp.json();
          setImages(data);
        }
      } catch (err) {
        console.error("Failed to fetch image cache:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchImages();
  }, []);

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={onClose}>
      <div className="media-manager-content" onClick={(e) => e.stopPropagation()}>
        <div className="media-header">
          <div className="title-area">
            <ImageIcon size={24} className="header-icon" />
            <h2>Media Manager</h2>
          </div>
          <button className="close-btn" onClick={onClose}><X size={22} /></button>
        </div>
        
        <div className="media-grid-container custom-scrollbar">
          {loading ? (
            <div className="media-status-state">
              <div className="spinner"></div>
              <p>Loading your gallery...</p>
            </div>
          ) : images.length === 0 ? (
            <div className="media-status-state">
              <ImageIcon size={72} style={{ opacity: 0.1, marginBottom: '20px' }} />
              <p>Your vault is empty.</p>
            </div>
          ) : (
            <div className="media-grid">
              {images.map((img) => (
                <div 
                  key={img.id} 
                  className="media-item-card"
                  onClick={() => onSelectImage(images.map(i => `http://localhost:8345${i.url}`), images.indexOf(img))}
                >
                  <div className="media-thumbnail-wrapper">
                    <img src={`http://localhost:8345${img.url}`} alt={img.prompt} loading="lazy" />
                  </div>
                  <div className="media-item-details">
                    <p className="media-prompt-text">{img.prompt}</p>
                    <div className="media-meta">
                      <span className="media-date">{new Date(img.timestamp).toLocaleDateString()}</span>
                      <span className="media-id-tag">ID: {img.id}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};


const GeneratedImage = ({ image, onImageClick, allInTurn = [] }) => {
  if (!image) return (
    <div className="assistant-image-error">
      <ImageIcon size={22} opacity={0.5} />
      <span>Missing image data</span>
    </div>
  );
  
  const data = typeof image === 'string' ? image : image.data;

  if (!data) return (
    <div className="assistant-image-error">
      <X size={22} color="#ff4444" />
      <span>Malformed image payload</span>
    </div>
  );

  const src = data.startsWith('http') ? data : `data:image/jpeg;base64,${data}`;

  return (
    <div className="assistant-image-wrapper">
      <img 
        src={src} 
        alt="AI Generated/Captured" 
        className="assistant-image"
        onClick={() => onImageClick(allInTurn.map(img => {
            const d = typeof img === 'string' ? img : img.data;
            return d.startsWith('http') ? d : `data:image/jpeg;base64,${d}`;
        }), allInTurn.indexOf(image))}
      />
    </div>
  );
};


const MessageContent = ({ content, images = [], attachments = [], weatherData, onImageClick }) => {
  // Pre-process for math delimiters (converts \( \) and \[ \] to $ and $$) with multiline support
  const processedContent = (content || '')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');

  return (
    <div className="message-content-wrapper">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        className="prose"
        components={{
          code({ node, inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            if (language === 'weather') {
              try {
                const weatherData = JSON.parse(String(children));
                return <WeatherWidget data={weatherData} />;
              } catch (e) {
                return <code className={className} {...props}>{children}</code>;
              }
            }
            return !inline ? (
              <CodeBlock language={language} value={String(children).replace(/\n$/, '')} />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          img({ node, ...props }) {
            return (
              <div className="markdown-image-container" onClick={() => onImageClick([props.src], 0)}>
                <img {...props} className="markdown-image" loading="lazy" />
              </div>
            );
          }
        }}
      >
        {processedContent}
      </ReactMarkdown>
      
      {weatherData && <WeatherWidget data={weatherData} />}
      
      {attachments && attachments.length > 0 && (
        <div className="message-attachments">
          {attachments.map((at, idx) => (
            <div key={idx} className="attachment-chip historical">
              <FileText size={16} className="chip-icon" />
              <span className="chip-name">{at.name}</span>
            </div>
          ))}
        </div>
      )}
      
      {images.length > 0 && (
        <div className="assistant-images-grid">
          {images.map((img, idx) => (
            <GeneratedImage 
              key={idx} 
              image={img} 
              allInTurn={images}
              onImageClick={onImageClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const VoicePlaybackOverlay = ({ analyser }) => {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 85;
      
      // Use a subset of bins for better speech visualization (ignore high frequency silence)
      const activeBins = Math.floor(bufferLength * 0.6); 
      
      // Draw circular waveform with symmetry
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 255, 230, 0.9)';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 15;
      ctx.shadowColor = 'rgba(0, 255, 200, 0.4)';

      for (let i = 0; i < activeBins; i++) {
        const value = dataArray[i];
        const percent = value / 255;
        const barHeight = percent * 45; 
        
        // Map the bins to the full circle
        const angle = (i / activeBins) * Math.PI * 2;
        
        const x1 = centerX + Math.cos(angle) * radius;
        const y1 = centerY + Math.sin(angle) * radius;
        const x2 = centerX + Math.cos(angle) * (radius + barHeight);
        const y2 = centerY + Math.sin(angle) * (radius + barHeight);

        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Additional pulsing glow
      const avgValue = dataArray.slice(0, activeBins).reduce((a, b) => a + b, 0) / activeBins;
      const pulseSize = (avgValue / 255) * 12;

      ctx.beginPath();
      const gradient = ctx.createRadialGradient(centerX, centerY, radius - 5, centerX, centerY, radius + 10 + pulseSize);
      gradient.addColorStop(0, 'rgba(0, 255, 230, 0.2)');
      gradient.addColorStop(0.5, 'rgba(0, 255, 230, 0.1)');
      gradient.addColorStop(1, 'rgba(0, 255, 230, 0)');
      ctx.fillStyle = gradient;
      ctx.arc(centerX, centerY, radius + 10 + pulseSize, 0, Math.PI * 2);
      ctx.fill();
    };

    draw();
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [analyser]);

  return (
    <div className="voice-overlay-container">
      <div className="voice-overlay-backdrop">
        <img src="/voice-bg.png" alt="Voice Background" className="voice-bg-img" />
        <div className="voice-overlay-vignette"></div>
      </div>
      <canvas ref={canvasRef} width={600} height={600} className="voice-canvas" />
      <div className="voice-status-label">SENTIENCE SPEAKING</div>
    </div>
  );
};

const App = () => {
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageGenStatus, setImageGenStatus] = useState({ active: false, percent: 0, preview: null });
  const [messages, setMessages] = useState([]);
  const [interimUserText, setInterimUserText] = useState('');
  const [interimAiText, setInterimAiText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMediaManager, setShowMediaManager] = useState(false);
  const [selectedGallery, setSelectedGallery] = useState(null); // { images: [], index: 0 }
  const [textInput, setTextInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [currentModel, setCurrentModel] = useState({ id: null, reason: null });
  const [isAiAudioPlaying, setIsAiAudioPlaying] = useState(false);

  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const isRecordingRequestedRef = useRef(false);
  const recordingTimeoutRef = useRef(null);
  const audioAccumulatorRef = useRef([]);



  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const currentAudioElementRef = useRef(null);
  const playbackAudioContextRef = useRef(null);
  const playbackAnalyserRef = useRef(null);

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
    setIsAiAudioPlaying(false);
  };

  const playNextAudio = () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    setIsAiAudioPlaying(true);

    if (!playbackAudioContextRef.current) {
      playbackAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      playbackAnalyserRef.current = playbackAudioContextRef.current.createAnalyser();
      playbackAnalyserRef.current.fftSize = 512;
      playbackAnalyserRef.current.connect(playbackAudioContextRef.current.destination);
    }

    const base64Audio = audioQueueRef.current.shift();
    const audio = new window.Audio("data:audio/wav;base64," + base64Audio);
    
    // Connect to visualizer
    const source = playbackAudioContextRef.current.createMediaElementSource(audio);
    source.connect(playbackAnalyserRef.current);

    currentAudioElementRef.current = audio;
    audio.onended = () => {
      if (audioQueueRef.current.length === 0) {
        setIsAiAudioPlaying(false);
      }
      playNextAudio();
    };
    
    if (playbackAudioContextRef.current.state === 'suspended') {
      playbackAudioContextRef.current.resume();
    }

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
          setMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              // Append content to existing assistant message
              const updatedLast = {
                ...lastMsg,
                content: (lastMsg.content && !lastMsg.content.includes(finalContent)) ? 
                         `${lastMsg.content}\n\n${finalContent}` : finalContent
              };
              return [...prev.slice(0, -1), updatedLast];
            }
            return [...prev, { role: 'assistant', content: finalContent }];
          });
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
      } else if (type === 'response.image.progress') {
        setImageGenStatus(prev => ({ ...prev, active: true, percent: lastJsonMessage.percent }));
      } else if (type === 'response.image.preview') {
        setImageGenStatus(prev => ({ ...prev, active: true, preview: lastJsonMessage.image }));
      } else if (type === 'response.image.done') {
        setImageGenStatus({ active: false, percent: 0, preview: null });
        const imageData = { data: lastJsonMessage.image, prompt: lastJsonMessage.full_prompt };
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
             const updatedLast = {
               ...lastMsg,
               images: [...(lastMsg.images || []), imageData]
             };
             return [...prev.slice(0, -1), updatedLast];
          } else {
            return [...prev, { role: 'assistant', content: '', images: [imageData] }];
          }
        });
      } else if (type === 'response.weather.done') {
        const { weather } = lastJsonMessage;
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            // Append weather data to existing assistant message if appropriate
            const updatedLast = {
              ...lastMsg,
              weatherData: weather
            };
            return [...prev.slice(0, -1), updatedLast];
          } else {
            return [...prev, { role: 'assistant', content: '', weatherData: weather }];
          }
        });
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
      content: content || (attachments.length > 0 ? "" : ""),
      images: attachments.filter(a => a.type.startsWith('image/')).map(a => a.data),
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
    console.log("DEBUG: startRecording called");
    interruptAudio();
    if (isRecording || streamRef.current) {
      console.log("DEBUG: Cleaning up existing microphone stream to prevent overlap leak.");
      stopRecording();
    }
    setIsRecording(true); // Immediate visual feedback
    isRecordingRequestedRef.current = true;
    try {
      console.log("DEBUG: Attempting to start userMedia...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      
      // If user released the key/button while we were waiting, kill it immediately!
      if (!isRecordingRequestedRef.current) {
        console.log("DEBUG: User stopped recording before stream was ready. Cancelling.");
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
        return;
      }
      
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      // Force resume for backgrounded tabs
      if (audioContext.state === 'suspended') await audioContext.resume();
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule('/audio-processor.js');
      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
      
      workletNode.port.onmessage = (event) => {
        // Accumulate until we have enough to justify a network packet
        audioAccumulatorRef.current.push(...event.data);
        
        if (audioAccumulatorRef.current.length >= 4096) {
          const pcmData = convertFloat32To16BitPCM(audioAccumulatorRef.current);
          const base64Audio = arrayBufferToBase64(pcmData.buffer);
          sendJsonMessage({ type: 'input_audio_buffer.append', audio: base64Audio });
          audioAccumulatorRef.current = [];
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination);
      workletNodeRef.current = workletNode;
      // setIsRecording already set true above
      sendJsonMessage({ type: "ui.recording.active" });
      console.log("DEBUG: Recording started successfully.");
      
      // Auto-stop after 30 seconds as a safety valve
      if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = setTimeout(() => {
        if (isRecordingRequestedRef.current) {
          console.log("DEBUG: Auto-stopping recording (30s limit reached)");
          stopRecording();
        }
      }, 30000);
    } catch (err) {
      console.error('Mic error:', err);
      setIsRecording(false);
      alert('Microphone error: ' + err.message);
    }
  };

  const stopRecording = () => {
    console.log("DEBUG: Stopping recording...");
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    isRecordingRequestedRef.current = false;
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close().catch(e => console.warn("AudioContext close error:", e));
      } catch (e) {}
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close().catch(e => console.warn("AudioContext close error:", e));
        }
      } catch (e) {}
      audioContextRef.current = null;
    }
    setIsRecording(false);
    if (audioAccumulatorRef.current.length > 0) {
      const pcmData = convertFloat32To16BitPCM(audioAccumulatorRef.current);
      const base64Audio = arrayBufferToBase64(pcmData.buffer);
      sendJsonMessage({ type: 'input_audio_buffer.append', audio: base64Audio });
      audioAccumulatorRef.current = [];
    }
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
        <div className="header-actions no-drag">
          <button className="icon-btn" title="Gallery" onClick={() => setShowMediaManager(true)}>
            <ImageIcon size={20} />
          </button>
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}

      <div className="messages-area">
        {isAiAudioPlaying && <VoicePlaybackOverlay analyser={playbackAnalyserRef.current} />}
        {isRecording && (
          <div className="recording-overlay">
            <div className="recording-pulse"></div>
            <span>SENTIENCE HEARING...</span>
          </div>
        )}
        {messages.length === 0 && !interimUserText && !interimAiText && !isRecording && (
          <div className="empty-state">
            <MessageSquare size={36} opacity={0.3} />
            <p>Ready for Alt + \ command</p>
          </div>
        )}
        
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <MessageContent 
              content={msg.content} 
              images={msg.images} 
              attachments={msg.attachments}
              weatherData={msg.weatherData}
              onImageClick={(gallery, index) => setSelectedGallery({ images: gallery, index })}
            />
          </div>
        ))}
        
        {interimUserText && (
          <div className="message user interim">
            <p>{interimUserText}</p>
          </div>
        )}
        
        {interimAiText && (
          <div className="message assistant interim">
            <MessageContent 
              content={interimAiText} 
              onImageClick={(src) => setSelectedImage(src)}
            />
          </div>
        )}
        
        {imageGenStatus.active && (
          <div className="message assistant interim image-gen-loading">
            <div className="image-gen-progress-card">
              <div className="image-gen-preview-wrapper">
                {imageGenStatus.preview ? (
                  <img src={`data:image/png;base64,${imageGenStatus.preview}`} className="image-gen-preview blur-in" alt="Progress" />
                ) : (
                  <div className="image-gen-placeholder">
                    <div className="shimmer"></div>
                    <ImageIcon size={36} opacity={0.2} />
                  </div>
                )}
                <div className="image-gen-overlay">
                  <div className="progress-arc-container">
                    <svg viewBox="0 0 36 36" className="progress-ring">
                      <path className="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                      <path className="ring-fill" strokeDasharray={`${imageGenStatus.percent}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    </svg>
                    <span className="progress-text">{imageGenStatus.percent}%</span>
                  </div>
                </div>
              </div>
              <div className="image-gen-label">
                <div className="pulse-dot"></div>
                Creating Artwork...
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {isAiAudioPlaying && (
        <div className="audio-interrupt-bar no-drag">
          <button className="interrupt-btn premium-glass" onClick={interruptAudio} title="Stop AI Voice">
            <div className="stop-square"></div>
            <span>STOP READING</span>
          </button>
        </div>
      )}

      <div className="input-area-wrapper">
        {attachments.length > 0 && (
          <div className="attachment-preview-area">
            {attachments.map(at => (
              <div key={at.id} className="attachment-chip">
                {at.preview ? (
                  <img src={at.preview} alt="preview" className="chip-thumb" />
                ) : (
                  <FileText size={16} className="chip-icon" />
                )}
                <span className="chip-name">{at.name}</span>
                <button className="chip-remove" onClick={() => removeAttachment(at.id)}>
                  <X size={14} />
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
            <Paperclip size={22} />
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
              <Send size={20} />
            </button>
          ) : (
            <button 
              className={`mic-btn no-drag ${isRecording ? 'recording' : ''}`}
              onClick={(e) => { 
                e.preventDefault(); 
                if (isRecording) stopRecording();
                else startRecording();
              }}
              disabled={!isConnected}
              title={isRecording ? "Click to stop" : "Click to speak"}
              style={{ marginBottom: '4px' }}
            >
              {isRecording ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
          )}

        </div>
      </div>

      {showMediaManager && (
        <MediaManagerModal 
          onClose={() => setShowMediaManager(false)} 
          onSelectImage={(gallery, index) => {
            setSelectedGallery({ images: gallery, index });
            // Don't close MediaManager anymore
          }}
        />
      )}

      {selectedGallery && (
        <ImageModal 
          images={selectedGallery.images} 
          initialIndex={selectedGallery.index}
          onClose={() => setSelectedGallery(null)} 
        />
      )}
    </div>
  );
};

export default App;
