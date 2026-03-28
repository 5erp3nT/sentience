import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Save, Search, ChevronDown, Check, Brain, Layers, Cpu } from 'lucide-react';

// ─── Reusable Model Selector ─────────────────────────────────────────────────
const ModelSelector = ({ label, badge, modelId, setModelId, availableModels, formatPrice, filterFn }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  const filtered = (filterFn
    ? availableModels.filter(filterFn)
    : availableModels
  ).filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  const selectedObj = availableModels.find(m => m.id === modelId) || { name: modelId, id: modelId };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
    } else {
      setSearch('');
    }
  }, [isOpen]);

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
        <ChevronDown size={16} color="var(--text-secondary)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </div>

      {isOpen && (
        <div className="custom-dropdown">
          <div className="dropdown-search">
            <Search size={14} color="var(--text-secondary)" />
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
                className={`dropdown-item ${modelId === m.id ? 'active' : ''}`}
                onClick={() => { setModelId(m.id); setIsOpen(false); }}
              >
                <div className="item-header">
                  <span className="item-name">{m.name}</span>
                  {parseFloat(m.pricing.prompt) === 0 && <span className="badge free">Free</span>}
                  {m.architecture?.modality?.includes('image') && <span className="badge vision">Vision</span>}
                  {modelId === m.id && <Check size={14} color="var(--accent)" />}
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
  const [model, setModel] = useState('google/gemma-2-9b-it:free');
  const [multimodalModel, setMultimodalModel] = useState('google/gemini-1.5-flash');
  const [heavyThinkerModel, setHeavyThinkerModel] = useState('google/gemini-pro-1.5');
  const [assistantName, setAssistantName] = useState('Antigravity');
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful and concise AI assistant living in the user's Linux status bar.");
  const [availableModels, setAvailableModels] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8345/v1/settings')
      .then(r => r.json())
      .then(data => {
        setApiKey(data.api_key || '');
        setModel(data.model || 'google/gemma-2-9b-it:free');
        setMultimodalModel(data.multimodal_model || 'google/gemini-1.5-flash');
        setHeavyThinkerModel(data.heavy_thinker_model || 'google/gemini-pro-1.5');
        setAssistantName(data.assistant_name || 'Antigravity');
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
          model,
          multimodal_model: multimodalModel,
          heavy_thinker_model: heavyThinkerModel,
          assistant_name: assistantName,
          system_prompt: systemPrompt,
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

  const visionFilter = m => m.architecture?.modality?.includes('image');

  return (
    <div className="settings-overlay">
      <div className="settings-modal flex-col">
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="icon-btn"><X size={20} /></button>
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

          {/* Model selectors section */}
          <div className="model-selectors-section">
            <div className="section-divider">
              <span>Model Configuration</span>
            </div>

            <ModelSelector
              label="Main Model"
              badge={{ cls: 'tools', icon: '🔧', text: 'Tool-capable only' }}
              modelId={model}
              setModelId={setModel}
              availableModels={availableModels}
              formatPrice={formatPrice}
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
              badge={{ cls: 'thinking', icon: '🧠', text: 'Auto-selected for complex reasoning' }}
              modelId={heavyThinkerModel}
              setModelId={setHeavyThinkerModel}
              availableModels={availableModels}
              formatPrice={formatPrice}
            />
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
            <Save size={16} /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;
