import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Save, Search, ChevronDown, Check, Brain, Layers, Cpu } from 'lucide-react';

// ─── Reusable Model Selector ─────────────────────────────────────────────────
const ModelSelector = ({ label, badge, modelId, setModelId, availableModels, formatPrice, filterFn }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  const filtered = (filterFn
    ? availableModels.filter(m => filterFn(m) || m.id === modelId)
    : availableModels
  ).filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  const selectedObj = availableModels.find(m => String(m.id) === String(modelId)) || { name: modelId, id: modelId };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isActive = (m) => String(modelId).toLowerCase().trim() === String(m.id).toLowerCase().trim();

  // Primary Scroll: Callback Ref
  const activeItemRef = useCallback((node) => {
    if (!node) return;
    const scroll = () => {
      const list = node.closest('.dropdown-list');
      if (list) {
        const rect = node.getBoundingClientRect();
        const containerRect = list.getBoundingClientRect();
        list.scrollTop = list.scrollTop + (rect.top - containerRect.top) - (list.clientHeight / 2) + (rect.height / 2);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(scroll));
    setTimeout(scroll, 100);
  }, []);

  // Fallback: Force scroll on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
      const timer = setTimeout(() => {
        const active = dropdownRef.current?.querySelector('.dropdown-item.active');
        if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setSearch('');
    }
  }, [isOpen, modelId]);

  return (
    <div className="form-group" ref={dropdownRef}>
      <label>
        {label}
        {badge && <span className={`badge-inline ${badge.cls}`}>{badge.icon} {badge.text}</span>}
      </label>
      {availableModels.length === 0 && <div className="loading-hint">Loading models from OpenRouter...</div>}
      <div className="custom-select-trigger" onClick={() => setIsOpen(!isOpen)}>
        <div className="selected-model-info">
          <span className="name">{selectedObj.name}</span>
          <span className="id">{selectedObj.id}</span>
        </div>
        <ChevronDown size={18} color="var(--text-secondary)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </div>

      {isOpen && (
        <div className="custom-dropdown">
          <div className="dropdown-search">
            <Search size={16} color="var(--text-secondary)" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="dropdown-list">
            {filtered.map(m => (
              <div
                key={m.id}
                ref={isActive(m) ? activeItemRef : undefined}
                className={`dropdown-item ${isActive(m) ? 'active' : ''}`}
                onClick={() => { setModelId(m.id); setIsOpen(false); }}
              >
                <div className="item-header">
                  <span className="item-name">{m.name}</span>
                  {parseFloat(m.pricing.prompt) === 0 && <span className="badge free">Free</span>}
                  {m.architecture?.modality?.includes('image') && <span className="badge vision">Vision</span>}
                  {isActive(m) && <Check size={16} color="var(--accent)" />}
                </div>
                <div className="item-id">{m.id}</div>
                <div className="item-meta">
                  <span>{Math.round(m.context_length / 1024)}k ctx</span>
                  <span>&bull;</span>
                  <span>In: {formatPrice(m.pricing.prompt)}</span>
                  <span>&bull;</span>
                  <span>Out: {formatPrice(m.pricing.completion)}</span>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <div className="no-results">No models found</div>}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Settings Panel ──────────────────────────────────────────────────────
const Settings = ({ onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [pollinationsKey, setPollinationsKey] = useState('');
  const [model, setModel] = useState('google/gemma-2-9b-it:free');
  const [multimodalModel, setMultimodalModel] = useState('google/gemini-1.5-flash');
  const [heavyThinkerModel, setHeavyThinkerModel] = useState('google/gemini-pro-1.5');
  const [ttsModel, setTtsModel] = useState('kokoro');
  const [kokoroVoice, setKokoroVoice] = useState('af_bella');
  const [chatterboxVoice, setChatterboxVoice] = useState('default');
  const [assistantName, setAssistantName] = useState('Antigravity');
  const [enableWaveform, setEnableWaveform] = useState(true);


  const [systemPrompt, setSystemPrompt] = useState("You are a helpful and concise AI assistant living in the user's Linux status bar.");
  const [availableModels, setAvailableModels] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8345/v1/settings')
      .then(r => r.json())
      .then(data => {
        setApiKey(data.api_key || '');
        setPollinationsKey(data.pollinations_key || '');
        setModel(data.model || 'google/gemma-2-9b-it:free');
        setMultimodalModel(data.multimodal_model || 'google/gemini-1.5-flash');
        setHeavyThinkerModel(data.heavy_thinker_model || 'google/gemini-pro-1.5');
        setTtsModel(data.tts_model || 'kokoro');
        setKokoroVoice(data.kokoro_voice || 'af_bella');
        setChatterboxVoice(data.chatterbox_voice || 'default');
        setAssistantName(data.assistant_name || 'Antigravity');
        setEnableWaveform(data.enable_waveform !== undefined ? data.enable_waveform : true);
        setSystemPrompt(data.system_prompt || "You are a helpful and concise AI assistant living in the user's Linux status bar.");
      })
      .catch(console.error);

    fetch('http://localhost:8345/v1/models')
      .then(r => r.json())
      .then(data => {
        if (data && data.data) {
          const sorted = data.data.sort((a, b) => {
            const aFree = parseFloat(a.pricing.prompt) === 0;
            const bFree = parseFloat(b.pricing.prompt) === 0;
            if (aFree && !bFree) return -1;
            if (!aFree && bFree) return 1;
            return a.name.localeCompare(b.name);
          });
          setAvailableModels(sorted);
        }
      })
      .catch(console.error);
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      await fetch('http://localhost:8345/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          pollinations_key: pollinationsKey,
          model,
          multimodal_model: multimodalModel,
          heavy_thinker_model: heavyThinkerModel,
          tts_model: ttsModel,
          kokoro_voice: kokoroVoice,
          chatterbox_voice: chatterboxVoice,
          assistant_name: assistantName,
          system_prompt: systemPrompt,
          enable_waveform: enableWaveform,
        })
      });
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const formatPrice = (str) => {
    const val = parseFloat(str);
    if (isNaN(val) || val === 0) return 'Free';
    return `$${(val * 1_000_000).toFixed(2)} / 1M`;
  };

  const visionFilter = m => 
    m.architecture?.modality?.includes('image') || 
    m.architecture?.input_modalities?.includes('image') ||
    m.id.toLowerCase().includes('vision') ||
    m.id.toLowerCase().includes('gemini'); // Gemini models are multimodal by default

  const standardFilter = m => !m.id.toLowerCase().includes('instruct') || m.id.toLowerCase().includes('it'); // Prefer IT/Instruct models

  const heavyFilter = m => 
    (m.context_length >= 120000 || m.id.toLowerCase().includes('pro') || m.id.toLowerCase().includes('opus') || m.id.toLowerCase().includes('405b') || m.id.toLowerCase().includes('70b')) && 
    !m.id.toLowerCase().includes('mini') && // Mini models are usually 'Main' not 'Heavy'
    !m.id.toLowerCase().includes('flash') && // Flash models are usually 'Main' or 'Multimodal'
    !m.id.toLowerCase().includes('gemma'); // Gemma is usually 'Main'


  return (
    <div className="settings-overlay">
      <div className="settings-modal flex-col">
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="icon-btn"><X size={22} /></button>
        </div>

        <div className="settings-content">

          {/* API Key */}
          <div className="form-group">
            <label>OpenRouter API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-or-v1-..."
            />
          </div>

          <div className="form-group">
            <label>Pollinations.ai API Key (Optional)</label>
            <input
              type="password"
              value={pollinationsKey}
              onChange={e => setPollinationsKey(e.target.value)}
              placeholder="Paste your Pollinations key for Flux/ZImage models"
            />
          </div>

          {/* Model selectors section */}
          <div className="model-selectors-section">
            <div className="section-divider">
              <span>Model Configuration</span>
            </div>

            <ModelSelector
              label="Standard Model"
              badge={{ cls: 'tools', icon: '🔧', text: 'Fast / Daily' }}
              modelId={model}
              setModelId={setModel}
              availableModels={availableModels}
              formatPrice={formatPrice}
              filterFn={standardFilter}
            />


            <ModelSelector
              label="Multi-modal Model"
              badge={{ cls: 'vision', icon: '👁️', text: 'Auto-selected for images & audio' }}
              modelId={multimodalModel}
              setModelId={setMultimodalModel}
              availableModels={availableModels}
              formatPrice={formatPrice}
              filterFn={visionFilter}
            />

            <ModelSelector
              label="Heavy Thinker"
              badge={{ cls: 'thinking', icon: '🧠', text: 'Deep Reasoning / Multi-Step' }}
              modelId={heavyThinkerModel}
              setModelId={setHeavyThinkerModel}
              availableModels={availableModels}
              formatPrice={formatPrice}
              filterFn={heavyFilter}
            />

            <div className="form-group">
              <label>
                Voice Engine (TTS)
                <span className="badge-inline tools"><Layers size={16} /> Speech Synthesis</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px', marginBottom: '8px' }}>
                <input
                  type="checkbox"
                  id="enableWaveform"
                  checked={enableWaveform}
                  onChange={e => setEnableWaveform(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--accent)' }}
                />
                <label htmlFor="enableWaveform" style={{ cursor: 'pointer', margin: 0, fontSize: '13px', color: 'var(--text-primary)' }}>
                  Show waveform while AI is speaking
                </label>
              </div>
              <div className="tts-selector-wrapper">
                <select 
                  value={ttsModel} 
                  onChange={e => setTtsModel(e.target.value)}
                  className="custom-select-trigger"
                  style={{ width: '100%', appearance: 'none', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '10px 14px', borderRadius: '8px', outline: 'none', cursor: 'pointer' }}
                >
                  <option value="kokoro">Kokoro v0.19 (Ultra-Fast / 82M)</option>
                  <option value="chatterbox">Chatterbox (Zero-Shot / Resemble AI)</option>
                </select>
                <ChevronDown size={14} className="select-icon-overlay" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }} />
              </div>
            </div>

            {ttsModel === 'kokoro' ? (
              <div className="form-group slide-in">
                <label>Kokoro Voice</label>
                <div className="tts-selector-wrapper">
                  <select 
                    value={kokoroVoice} 
                    onChange={e => setKokoroVoice(e.target.value)}
                    className="custom-select-trigger"
                    style={{ width: '100%', appearance: 'none', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '10px 14px', borderRadius: '8px', outline: 'none', cursor: 'pointer' }}
                  >
                    <option value="af_bella">Bella (US-F)</option>
                    <option value="af_nicole">Nicole (US-F)</option>
                    <option value="af_sarah">Sarah (US-F)</option>
                    <option value="am_adam">Adam (US-M)</option>
                    <option value="am_michael">Michael (US-M)</option>
                    <option value="bf_alice">Alice (UK-F)</option>
                    <option value="bf_emma">Emma (UK-F)</option>
                    <option value="bm_george">George (UK-M)</option>
                    <option value="bm_lewis">Lewis (UK-M)</option>
                  </select>
                  <ChevronDown size={16} className="select-icon-overlay" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }} />
                </div>
              </div>
            ) : (
              <div className="form-group slide-in">
                <label>Chatterbox Voice Presets</label>
                <div className="tts-selector-wrapper">
                  <select 
                    value={chatterboxVoice} 
                    onChange={e => setChatterboxVoice(e.target.value)}
                    className="custom-select-trigger"
                    style={{ width: '100%', appearance: 'none', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '10px 14px', borderRadius: '8px', outline: 'none', cursor: 'pointer' }}
                  >
                    <option value="default">Resemble Baseline (conds.pt)</option>
                    <option value="male_david">David (Deep US-Male)</option>
                    <option value="female_lj">Linda (Clear US-Female)</option>
                    <option value="user_cloned">Cloned (Your Voice!)</option>
                  </select>
                  <ChevronDown size={16} className="select-icon-overlay" style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }} />
                </div>
              </div>
            )}



          </div>

          {/* Assistant name */}
          <div className="form-group">
            <label>Assistant Name</label>
            <input
              type="text"
              value={assistantName}
              onChange={e => setAssistantName(e.target.value)}
            />
          </div>

          {/* System prompt */}
          <div className="form-group">
            <label>Personality / System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={4}
            />
          </div>
        </div>

        <div className="settings-footer">
          <button onClick={handleSave} disabled={loading} className="btn-save">
            <Save size={18} /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;
