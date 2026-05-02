import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PoseEngine } from './lib/pose-engine';
import { 
  Camera, 
  Activity, 
  User, 
  Binary, 
  Play, 
  Square, 
  CheckCircle, 
  AlertCircle, 
  RefreshCw,
  ArrowLeft,
  ChevronRight,
  UploadCloud
} from 'lucide-react';
import { PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { supabase } from './lib/supabase';
import { evaluateCaptureReadiness } from './lib/quality';

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'N/A' },
] as const;

type Gender = (typeof GENDER_OPTIONS)[number]['value'];
type Step = 'home' | 'testing' | 'recording' | 'confirm';

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
      }
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

  // App State
  const [step, setStep] = useState<Step>('home');
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [duration, setDuration] = useState(0);
  const [latestResults, setLatestResults] = useState<PoseLandmarkerResult | null>(null);

  // Metadata State
  const [sessionId, setSessionId] = useState('');
  const [age, setAge] = useState<string>('');
  const [gender, setGender] = useState<Gender>('prefer_not_to_say');
  const [showPermissionGuide, setShowPermissionGuide] = useState(false);

  useEffect(() => {
    if (step === 'testing' || step === 'recording') {
      initCamera();
    }
    return () => {
      engineRef.current?.close();
      engineRef.current = null;
    };
  }, [step]);

  const initCamera = async () => {
    try {
      // Wait for refs
      await new Promise(r => setTimeout(r, 100));
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
        startEngineLoop();
      };
    } catch (err) {
      console.error(err);
      if (window.location.hostname !== 'localhost' && window.location.protocol !== 'https:') {
        setShowPermissionGuide(true);
      } else {
        alert('Camera access failed. Please check your browser permissions.');
      }
    }
  };

  const startEngineLoop = async () => {
    const loop = async () => {
      if (videoRef.current && engineRef.current) {
        await engineRef.current.send(videoRef.current);
        requestAnimationFrame(loop);
      }
    };
    loop();
  };

  const handlePoseResults = (results: PoseLandmarkerResult) => {
    setLatestResults(results);
    
    if (isRecording && results.landmarks && results.landmarks.length > 0) {
      const poseLandmarks = results.landmarks[0];
      const frame = poseLandmarks.map(lm => [
        lm.x, lm.y, lm.z, lm.visibility ?? 0
      ]);
      
      framesRef.current.push(frame);
      const elapsed = Date.now() - startTimeRef.current;
      timestampsRef.current.push(elapsed);
      setFrameCount(framesRef.current.length);
      setDuration(elapsed);
    }
  };

  const startRecording = () => {
    framesRef.current = [];
    timestampsRef.current = [];
    startTimeRef.current = Date.now();
    setFrameCount(0);
    setDuration(0);
    setIsRecording(true);
    setStep('recording');
  };

  const stopRecording = () => {
    setIsRecording(false);
    setStep('confirm');
  };

  const finalizeUpload = async () => {
    setIsUploading(true);
    
    const captureId = `web_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const safeAge = parseInt(age);
    const lastTs = timestampsRef.current[timestampsRef.current.length - 1] || 1;
    const actualFps = framesRef.current.length / (lastTs / 1000);

    const payload = {
      keypoints: framesRef.current,
      timestamps: timestampsRef.current,
      meta: {
        fps_nominal: isFinite(actualFps) ? actualFps : 30,
        resolution: [1280, 720],
        device: 'Web Chrome',
        camera_facing: 'front',
        session_id: sessionId || `web_${Date.now()}`,
        age: isNaN(safeAge) ? null : safeAge,
        gender: gender
      }
    };

    const success = await uploadToSupabaseDirect(payload, captureId);
    setIsUploading(false);

    if (success) {
      alert('Data uploaded successfully to Supabase!');
      setStep('home');
    } else {
      alert('Upload failed. Please check your network or storage policies.');
    }
  };

  const readiness = evaluateCaptureReadiness(latestResults, isReady);

  return (
    <div className="app-root">
      {step === 'home' && (
        <div className="app-container">
          <div className="step-container">
            <h1 className="home-title">Pose Capture Studio</h1>
            <p className="home-subtitle">Complete the setup to start recording.</p>

            <div className="card">
              <div className="card-title">Session Setup</div>
              <label className="input-label" style={{fontSize: 12, fontWeight: 700, color: '#2F4E63'}}>Session ID</label>
              <input 
                className="input-field" 
                placeholder="Optional session id"
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              />
              
              <div style={{marginTop: 12}}>
                <label className="input-label" style={{fontSize: 12, fontWeight: 700, color: '#2F4E63'}}>Participant Age</label>
                <input 
                  type="number" 
                  className="input-field" 
                  placeholder="Required age"
                  value={age}
                  onChange={e => setAge(e.target.value)}
                />
              </div>

              <div style={{marginTop: 12}}>
                <label className="input-label" style={{fontSize: 12, fontWeight: 700, color: '#2F4E63'}}>Gender</label>
                <div className="chip-grid">
                  {GENDER_OPTIONS.map(opt => (
                    <div 
                      key={opt.value}
                      className={`chip ${gender === opt.value ? 'active' : ''}`}
                      onClick={() => setGender(opt.value)}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Capture Rules</div>
              <p className="check-item">1. Full body must be visible.</p>
              <p className="check-item">2. Good lighting is required.</p>
              <p className="check-item">3. Stand 6-8 feet from camera.</p>
            </div>

            <button 
              className="btn btn-primary" 
              disabled={!age}
              onClick={() => setStep('testing')}
            >
              Start Capture Flow <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}

      {step === 'testing' && (
        <div className="app-container">
          <div className="step-container">
            <div className="camera-wrapper">
              <video ref={videoRef} className="camera-stream" autoPlay playsInline muted />
              <canvas ref={canvasRef} className="landmark-canvas" width={1280} height={720} />
            </div>

            <div className="testing-panel">
              <div className="card-title">Pre-Capture Check</div>
              {readiness.checks.map(c => (
                <p key={c.id} className={`check-item ${c.ok ? 'check-ok' : 'check-fail'}`}>
                  {c.ok ? '??' : '??'} {c.label}: {c.detail}
                </p>
              ))}
              <p style={{marginTop: 8, fontWeight: 700, fontSize: 13, color: readiness.ready ? 'var(--success)' : 'var(--error)'}}>
                {readiness.summary}
              </p>
            </div>

            <div style={{display: 'flex', gap: 10, marginTop: 'auto', paddingBottom: 20}}>
              <button className="btn btn-secondary" onClick={() => setStep('home')}>
                <ArrowLeft size={18} /> Back
              </button>
              <button 
                className="btn btn-primary" 
                disabled={!readiness.ready}
                onClick={startRecording}
              >
                Start Recording
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'recording' && (
        <div className="app-container">
          <div className="step-container" style={{padding: 0}}>
            <div className="camera-wrapper" style={{height: '100vh', borderRadius: 0, margin: 0}}>
              <video ref={videoRef} className="camera-stream" autoPlay playsInline muted />
              <canvas ref={canvasRef} className="landmark-canvas" width={1280} height={720} />
              
              <div className="recording-bar">
                REC {(duration/1000).toFixed(1)}s | {frameCount} Frames
              </div>

              <div className="stop-btn-overlay">
                <button className="btn btn-danger" onClick={stopRecording}>
                  <Square size={20} fill="currentColor" /> Stop Recording
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="app-container">
          <div className="step-container">
            <h1 className="home-title">Review Capture</h1>
            <p className="home-subtitle">Verify data before sending to cloud.</p>

            <div className="card">
              <div className="card-title">Recording Summary</div>
              <p className="check-item">Frames: {frameCount}</p>
              <p className="check-item">Duration: {(duration/1000).toFixed(1)}s</p>
            </div>

            <div className="card">
              <div className="card-title">Metadata</div>
              <p className="check-item">Age: {age}</p>
              <p className="check-item">Gender: {gender}</p>
              <p className="check-item">Session: {sessionId || 'Auto'}</p>
            </div>

            <div style={{marginTop: 'auto', paddingBottom: 20}}>
              <button 
                className="btn btn-primary" 
                disabled={isUploading}
                onClick={finalizeUpload}
              >
                {isUploading ? <RefreshCw className="animate-spin" /> : <UploadCloud />}
                {isUploading ? 'Uploading...' : 'Send to Supabase Cloud'}
              </button>
              <button 
                className="btn btn-secondary" 
                style={{marginTop: 10}}
                disabled={isUploading}
                onClick={() => setStep('home')}
              >
                Discard Capture
              </button>
            </div>
          </div>
        </div>
      )}

      {showPermissionGuide && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(5, 27, 44, 0.95)', zIndex: 1000,
          padding: 32, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', color: 'white',
          textAlign: 'center'
        }}>
          <AlertCircle size={64} color="#ff4d4d" style={{ marginBottom: 20 }} />
          <h2 style={{ marginBottom: 12 }}>Camera Blocked</h2>
          <p style={{ marginBottom: 20, fontSize: 14, opacity: 0.9, lineHeight: 1.5 }}>
            Chrome blocks cameras on Wi-Fi links for security.
          </p>
          <div style={{
            backgroundColor: 'rgba(255,255,255,0.1)', padding: 16,
            borderRadius: 12, textAlign: 'left', fontSize: 13, marginBottom: 24,
            width: '100%', maxWidth: 400
          }}>
            <p style={{ marginBottom: 8 }}>1. Go to <b>chrome://flags</b></p>
            <p style={{ marginBottom: 8 }}>2. Search: <b>unsafely-treat-insecure-origin-as-secure</b></p>
            <p style={{ marginBottom: 8 }}>3. Add <b>{window.location.origin}</b></p>
            <p>4. Set to <b>Enabled</b> and Relaunch.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowPermissionGuide(false)}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
