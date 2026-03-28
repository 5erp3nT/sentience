import React, { useState, useEffect, useRef } from 'react';
import { X, Save, Search, ChevronDown, Check } from 'lucide-react';

const Settings = ({ onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('google/gemma-2-9b-it:free');
  const [assistantName, setAssistantName] = useState('Antigravity');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful and concise AI assistant living in the user\'s Linux status bar.');
  const [availableModels, setAvailableModels] = useState([]);
  const [loading, setLoading] = useState(false);
  
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  
  const dropdownRef = useRef(null);

  useEffect(() => {
    // Load existing settings
    fetch('http://localhost:8345/v1/settings')
      .then(r => r.json())
      .then(data => {
        setApiKey(data.api_key || '');
        setModel(data.model || 'google/gemma-2-9b-it:free');
        setAssistantName(data.assistant_name || 'Antigravity');
        setSystemPrompt(data.system_prompt || 'You are a helpful and concise AI assistant living in the user\'s Linux status bar.');
      })
      .catch(console.error);

    // Fetch available models
    fetch('http://localhost:8345/v1/models')
      .then(r => r.json())
      .then(data => {
        if (data && data.data) {
          // Sort models: free first, then by name
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
      
    // Handle outside clicks for dropdown
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
          assistant_name: assistantName,
          system_prompt: systemPrompt
        })
      });
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const selectedModelObj = availableModels.find(m => m.id === model) || { name: model, id: model };
  
  const filteredModels = availableModels.filter(m => 
    m.name.toLowerCase().includes(modelSearch.toLowerCase()) || 
    m.id.toLowerCase().includes(modelSearch.toLowerCase())
  );

  const formatPrice = (str) => {
    const val = parseFloat(str);
    if (isNaN(val) || val === 0) return 'Free';
    // Price from OpenRouter is usually per 1 token. We show per 1M.
    const perMillion = val * 1000000;
    return `$${perMillion.toFixed(2)} / 1M`;
  };

  return (
    <div className="settings-overlay">
      <div className="settings-modal flex-col">
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="icon-btn"><X size={20} /></button>
        </div>
        
        <div className="settings-content">
          <div className="form-group">
            <label>OpenRouter API Key</label>
            <input 
              type="password" 
              value={apiKey} 
              onChange={e => setApiKey(e.target.value)} 
              placeholder="sk-or-v1-..."
            />
          </div>

          <div className="form-group" ref={dropdownRef}>
            <label>AI Model <span className="badge-inline tools">🔧 Tool-capable only</span></label>
            {availableModels.length === 0 && <div className="loading-hint">Loading models from OpenRouter...</div>}
            <div className="custom-select-trigger" onClick={() => setIsDropdownOpen(!isDropdownOpen)}>
               <div className="selected-model-info">
                  <span className="name">{selectedModelObj.name}</span>
                  <span className="id">{selectedModelObj.id}</span>
               </div>
               <ChevronDown size={16} color="var(--text-secondary)" />
            </div>
            
            {isDropdownOpen && (
              <div className="custom-dropdown">
                 <div className="dropdown-search">
                    <Search size={14} color="var(--text-secondary)" />
                    <input 
                      type="text" 
                      placeholder="Search models..." 
                      value={modelSearch}
                      onChange={e => setModelSearch(e.target.value)}
                      onClick={e => e.stopPropagation()}
                    />
                 </div>
                 <div className="dropdown-list">
                    {filteredModels.map(m => (
                      <div 
                        key={m.id} 
                        className={`dropdown-item ${model === m.id ? 'active' : ''}`}
                        onClick={() => {
                          setModel(m.id);
                          setIsDropdownOpen(false);
                          setModelSearch('');
                        }}
                      >
                        <div className="item-header">
                          <span className="item-name">{m.name}</span>
                          {parseFloat(m.pricing.prompt) === 0 && <span className="badge free">Free</span>}
                          {m.architecture?.modality?.includes("image") && <span className="badge vision">Vision</span>}
                          {model === m.id && <Check size={14} color="var(--accent)" />}
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
                    {filteredModels.length === 0 && <div className="no-results">No models found</div>}
                 </div>
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Assistant Name</label>
            <input 
              type="text" 
              value={assistantName} 
              onChange={e => setAssistantName(e.target.value)} 
            />
          </div>

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
