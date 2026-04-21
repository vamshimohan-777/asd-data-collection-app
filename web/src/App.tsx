import React, { useEffect, useRef, useState } from 'react';
import { PoseEngine } from './lib/pose-engine';
import { Camera, Activity, User, Binary, Play, Square, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { supabase } from './lib/supabase';

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'N/A' },
] as const;

type Gender = (typeof GENDER_OPTIONS)[number]['value'];

async function uploadToSupabaseDirect(payload: any, captureId: string) {
  try {
    const fileName = `${captureId}/raw_capture.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

    const { error: storageError } = await supabase.storage
      .from('pose-captures')
      .upload(fileName, blob, {
        upsert: true
      });

    if (storageError) throw storageError;

    const { error: dbError } = await supabase.from('captures').insert({
      capture_id: captureId,
      meta: payload.meta,
      storage_paths: {
        raw_json: fileName
      },
      source: 'web_direct'
    });

    if (dbError) throw dbError;
    return true;
  } catch (err) {
    console.error('Web Supabase direct sync failed:', err);
    return false;
  }
}

export default function App() {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PoseEngine | null>(null);
  
  // Recording Data
  const framesRef = useRef<number[][][]>([]);
  const timestampsRef = useRef<number[]>([]);
  const startTimeRef = useRef<number>(0);

  // UI State
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState<string>('Ready to record');
  const [frameCount, setFrameCount] = useState(0);
  const [syncToSupabase, setSyncToSupabase] = useState(true);

  // Metadata State
  const [sessionId, setSessionId] = useState('');
  const [age, setAge] = useState<string>('');
  const [gender, setGender] = useState<Gender>('male');

  // Backend Config
  const backendUrl = 'http://localhost:8000'; // Standard default

  useEffect(() => {
    init();
    return () => {
      engineRef.current?.close();
    };
  }, []);

  const init = async () => {
    try {
      if (!videoRef.current || !canvasRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      
      videoRef.current.srcObject = stream;
      
      const engine = new PoseEngine(videoRef.current, canvasRef.current);
      engine.onResults(handlePoseResults);
      engineRef.current = engine;

      videoRef.current.onloadedmetadata = () => {
        setIsReady(true);
        setStatus('Ready to record');
        startEngineLoop();
      };
    } catch (err) {
      console.error(err);
      setStatus('Camera access denied or failed');
    }
  };

  const startEngineLoop = async () => {
    if (!videoRef.current || !engineRef.current) return;
    
    const loop = async () => {
      if (videoRef.current && engineRef.current) {
        await engineRef.current.send(videoRef.current);
      }
      requestAnimationFrame(loop);
    };
    loop();
  };

  const handlePoseResults = (results: PoseLandmarkerResult) => {
    if (isRecordingRef.current && results.landmarks && results.landmarks.length > 0) {
      // Collect frame data: [33 joints][4 values]
      const poseLandmarks = results.landmarks[0];
      const frame = poseLandmarks.map(lm => [
        lm.x, lm.y, lm.z, lm.visibility ?? 0
      ]);
      
      framesRef.current.push(frame);
      timestampsRef.current.push(Date.now() - startTimeRef.current);
      setFrameCount(f => f + 1);
    }
  };

  const toggleRecording = () => {
    if (!isRecording) {
      // Start
      framesRef.current = [];
      timestampsRef.current = [];
      startTimeRef.current = Date.now();
      setFrameCount(0);
      setIsRecording(true);
      isRecordingRef.current = true;
      setStatus('Recording...');
    } else {
      // Stop
      setIsRecording(false);
      isRecordingRef.current = false;
      setStatus('Recording captured. Finalizing...');
      // Small delay for final frames
      setTimeout(finalizeRecording, 500);
    }
  };

  const finalizeRecording = async () => {
    if (framesRef.current.length === 0) {
      setStatus('No data captured');
      return;
    }

    setIsUploading(true);
    setStatus('Uploading to Atlas...');

    const safeAge = parseInt(age);
    const lastTimestamp = timestampsRef.current[timestampsRef.current.length - 1] || 1;
    const safeFps = framesRef.current.length / (lastTimestamp / 1000);

    const payload = {
      keypoints: framesRef.current,
      timestamps: timestampsRef.current,
      meta: {
        fps_nominal: isFinite(safeFps) ? safeFps : 30.0,
        resolution: [1280, 720],
        device: 'Web Browser (Desktop)',
        camera_facing: 'front',
        session_id: sessionId || `web_${Date.now()}`,
        age: isNaN(safeAge) ? null : safeAge,
        gender: gender
      }
    };

    try {
      const resp = await fetch(`${backendUrl}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

        if (resp.ok) {
          const data = await resp.json();
          setStatus(`Success! Capture ID: ${data.capture_id}`);

          // Parallel Direct Supabase Sync
          if (syncToSupabase) {
            uploadToSupabaseDirect(payload, data.capture_id).then(success => {
              if (success) {
                setStatus(prev => prev + ' | Supabase Synced');
              } else {
                setStatus(prev => prev + ' | Supabase Sync Failed');
              }
            }).catch(err => {
              console.warn('Background Supabase sync failed:', err);
            });
          }
        } else {
        const err = await resp.json();
        setStatus(`Upload Failed: ${err.detail || 'Server error'}`);
      }
    } catch (err) {
      setStatus('Backend unreachable. Check CORS or server status.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="app-container">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="logo-section">
          <div className="logo-icon" />
          <h1 className="logo-text">QUANTUM POSE</h1>
        </div>

        <nav>
          <div className="section-label">Session Setup</div>
          
          <div className="form-group">
            <label className="form-label">
              <Binary size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Session ID
            </label>
            <input 
              className="input-field" 
              placeholder="Auto-generated if empty"
              value={sessionId}
              onChange={e => setSessionId(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              <User size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Participant Age
            </label>
            <input 
              type="number" 
              className="input-field" 
              placeholder="e.g. 25"
              value={age}
              onChange={e => setAge(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Gender Selection</label>
            <div className="gender-grid">
              {GENDER_OPTIONS.map(opt => (
                <div 
                  key={opt.value}
                  className={`gender-chip ${gender === opt.value ? 'active' : ''}`}
                  onClick={() => setGender(opt.value)}
                >
                  {opt.label}
                </div>
              ))}
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
            <div 
              className={`gender-chip ${syncToSupabase ? 'active' : ''}`}
              style={{ width: '100%', textAlign: 'center', cursor: 'pointer' }}
              onClick={() => setSyncToSupabase(!syncToSupabase)}
            >
              {syncToSupabase ? 'Supabase Sync: ON' : 'Supabase Sync: OFF'}
            </div>
          </div>

          <div className="section-label" style={{ marginTop: 32 }}>Controls</div>
          
          <button 
            className={`btn ${isRecording ? 'btn-danger' : 'btn-primary'}`}
            disabled={!isReady || isUploading}
            onClick={toggleRecording}
          >
            {isRecording ? (
              <><Square size={20} fill="currentColor" /> Stop Capture</>
            ) : (
              <><Play size={20} fill="currentColor" /> Start Capture</>
            )}
          </button>

          <div className="status-badge">
            <div style={{ marginBottom: 4, fontWeight: 700, color: '#fff' }}>
              {frameCount} frames collected
            </div>
            {status}
          </div>
        </nav>

        <div style={{ marginTop: 'auto', fontSize: '10px', color: 'var(--text-dim)' }}>
          QUANTUM POSE V0.1.0 • DESKTOP STUDIO
        </div>
      </aside>

      {/* VIEWPORT */}
      <main className="main-content">
        <div className="camera-wrapper">
          <video 
            ref={videoRef} 
            className="camera-stream" 
            autoPlay 
            playsInline 
            muted 
          />
          <canvas 
            ref={canvasRef} 
            className="landmark-canvas"
            width={1280}
            height={720}
          />

          {isRecording && (
            <div className="recording-indicator">
              <div style={{ width: 8, height: 8, borderRadius: 4, background: '#ff4d4d' }} />
              REC LIVE
            </div>
          )}

          <div className="overlay-stats">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Camera size={14} color="var(--accent)" />
                <span>1280x720</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Activity size={14} color="var(--accent)" />
                <span>Real-time ML Active</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
