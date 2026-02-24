/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Stars, Float, Text, Html } from '@react-three/drei';
import { Bloom, EffectComposer, Noise, Vignette, Glitch } from '@react-three/postprocessing';
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { motion, AnimatePresence } from 'motion/react';
import { Plane, Wind, Zap, Gauge, Navigation } from 'lucide-react';

// --- Constants ---
const CHUNK_SIZE = 100;
const CHUNK_DIVISIONS = 50;
const TERRAIN_WIDTH = 120;
const TERRAIN_HEIGHT = 12;
const SPEED = 20;

// --- Components ---

const Terrain = ({ virtualPos, cameraAngle, shipVirtualPos, globalDangerBoundsRef }: { virtualPos: React.MutableRefObject<THREE.Vector2>, cameraAngle: React.MutableRefObject<number>, shipVirtualPos: React.MutableRefObject<THREE.Vector2>, globalDangerBoundsRef: React.MutableRefObject<THREE.Vector2> }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  const dangerZones = useMemo(() => {
    const arr = [];
    for(let i=0; i<4; i++) arr.push(new THREE.Vector4(0, 0, -9999, 0));
    return arr;
  }, []);
  const nextSpawnTime = useRef(2);
  const zoneIndex = useRef(0);

  const shaderArgs = useMemo(() => ({
    uniforms: {
      uVirtualPos: { value: new THREE.Vector2() },
      uCameraAngle: { value: 0 },
      uColor: { value: new THREE.Color("#ff00ff") },
      uHeight: { value: 45.0 },
      uTime: { value: 0 },
      uDangerZones: { value: dangerZones },
      uGlobalDangerBounds: { value: new THREE.Vector2(-99999, -99999) }
    },
    vertexShader: `
      uniform vec2 uVirtualPos;
      uniform float uCameraAngle;
      uniform float uHeight;
      varying vec2 vVirtualPos;
      varying float vHeight;
      varying float vDist;

      vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
      float snoise(vec2 v){
        const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                 -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v -   i + dot(i, C.xx);
        vec2 i1;
        i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod(i, 289.0);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
        + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
          dot(x12.zw,x12.zw)), 0.0);
        m = m*m ;
        m = m*m ;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 a0 = x - floor(x + 0.5);
        vec3 m1 = 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        g *= m1;
        return 130.0 * dot(m, g);
      }

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec2 sceneXZ = worldPosition.xz;
        
        vDist = distance(worldPosition.xyz, cameraPosition);
        
        // Map scene coordinates to virtual world coordinates based on CAMERA angle
        // This ensures the terrain moves "towards the viewer"
        vec2 forwardXZ = vec2(sceneXZ.x, -sceneXZ.y);
        float c = cos(uCameraAngle);
        float s = sin(uCameraAngle);
        vec2 virtualOffset = vec2(
          forwardXZ.x * c + forwardXZ.y * s,
          -forwardXZ.x * s + forwardXZ.y * c
        );
        
        vVirtualPos = uVirtualPos + virtualOffset;
        
        // Generate noise
        float noiseVal = snoise(vVirtualPos * 0.012);
        float normalizedNoise = pow((noiseVal + 1.0) * 0.5, 1.5);
        float h = normalizedNoise * uHeight;
        
        // Objective curving canyon in the virtual world
        float canyonX = sin(vVirtualPos.y * 0.002) * 200.0 + sin(vVirtualPos.y * 0.005) * 50.0;
        float trench = smoothstep(20.0, 100.0, abs(vVirtualPos.x - canyonX));
        h *= trench;
        
        vHeight = h;
        
        vec3 newPos = position;
        newPos.z += h;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform vec4 uDangerZones[4];
      uniform vec2 uGlobalDangerBounds;
      varying vec2 vVirtualPos;
      varying float vHeight;
      varying float vDist;

      float getDangerIntensity(vec2 vPos) {
        float intensity = 0.0;
        for(int i=0; i<4; i++) {
          vec4 zone = uDangerZones[i];
          float age = uTime - zone.z;
          if (age > 0.0 && age < 20.0) {
            vec2 localPos = vPos - zone.xy;
            if (localPos.x >= 0.0 && localPos.x < 16.0 && localPos.y >= 0.0 && localPos.y < 16.0) {
              float col = floor(localPos.x / 4.0);
              float row = floor(localPos.y / 4.0);
              float bitIndex = row * 4.0 + col;
              
              float bit = mod(floor(zone.w / pow(2.0, bitIndex)), 2.0);
              if (bit > 0.5) {
                float flicker = sin(uTime * 15.0 + bitIndex) * 0.5 + 0.5;
                float fastFlicker = sin(uTime * 50.0) * 0.5 + 0.5;
                flicker = mix(flicker, fastFlicker, 0.3);
                
                float fade = smoothstep(20.0, 18.0, age) * smoothstep(0.0, 2.0, age);
                intensity = max(intensity, flicker * fade);
              }
            }
          }
        }
        return intensity;
      }

      void main() {
        float gridSize = 4.0;
        vec2 grid = abs(fract(vVirtualPos / gridSize - 0.5) - 0.5) / fwidth(vVirtualPos / gridSize);
        float line = min(grid.x, grid.y);
        float gridAlpha = 1.0 - smoothstep(0.0, 1.0, line);
        
        vec3 color = uColor;
        float peakFactor = smoothstep(10.0, 30.0, vHeight);
        color = mix(uColor, vec3(0.0, 1.0, 1.0), peakFactor);
        
        float danger = getDangerIntensity(vVirtualPos);
        
        float cellY = floor(vVirtualPos.y / 4.0) * 4.0;
        if (cellY >= uGlobalDangerBounds.x && cellY <= uGlobalDangerBounds.y) {
            vec2 cell = floor(vVirtualPos / 4.0);
            float hash = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
            if (hash > 0.2) {
                float flicker = sin(uTime * 30.0 + hash * 20.0) * 0.5 + 0.5;
                danger = max(danger, flicker);
            }
        }
        
        if (danger > 0.0) {
          color = mix(color, vec3(1.0, 0.1, 0.1), danger);
          gridAlpha = max(gridAlpha, danger * 0.85);
        }
        
        float fog = smoothstep(40.0, 160.0, vDist);
        
        vec3 finalColor = color;
        float finalAlpha = mix(gridAlpha * 0.9, 0.0, fog);
        
        if (gridAlpha > 0.05) {
          gl_FragColor = vec4(finalColor, finalAlpha);
        } else {
          gl_FragColor = vec4(0.02, 0.02, 0.02, mix(1.0, 0.0, fog));
        }
      }
    `,
    transparent: true,
  }), []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const time = state.clock.getElapsedTime();
    
    if (time > nextSpawnTime.current && shipVirtualPos) {
      nextSpawnTime.current = time + 10 + Math.random() * 10;
      
      const spawnY = shipVirtualPos.current.y + 300 + Math.random() * 200;
      const canyonX = Math.sin(spawnY * 0.002) * 200.0 + Math.sin(spawnY * 0.005) * 50.0;
      const spawnX = canyonX + (Math.random() - 0.5) * 60.0;
      
      const gridX = Math.floor(spawnX / 4.0) * 4.0;
      const gridY = Math.floor(spawnY / 4.0) * 4.0;
      
      let pattern = 0;
      const numCells = 1 + Math.floor(Math.random() * 16);
      let availableBits = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
      for(let i=0; i<numCells; i++) {
        const idx = Math.floor(Math.random() * availableBits.length);
        const bit = availableBits.splice(idx, 1)[0];
        pattern |= (1 << bit);
      }
      
      dangerZones[zoneIndex.current].set(gridX, gridY, time, pattern);
      zoneIndex.current = (zoneIndex.current + 1) % 4;
    }

    const material = meshRef.current.material as THREE.ShaderMaterial;
    material.uniforms.uVirtualPos.value.copy(virtualPos.current);
    material.uniforms.uCameraAngle.value = cameraAngle.current;
    material.uniforms.uTime.value = time;
    material.uniforms.uGlobalDangerBounds.value.copy(globalDangerBoundsRef.current);
  });

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -5, 0]}>
      <planeGeometry args={[400, 400, 200, 200]} />
      <shaderMaterial attach="material" {...shaderArgs} />
    </mesh>
  );
};

const Meteors = () => {
  const count = 1;
  const meteors = useMemo(() => {
    return Array.from({ length: count }).map(() => ({
      position: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(0, 0, 0),
      scale: 0.1 + Math.random() * 0.2,
      active: false,
      timer: Math.random() * 5
    }));
  }, []);

  const refs = useRef<THREE.Mesh[]>([]);

  useFrame((state, delta) => {
    meteors.forEach((m, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;

      if (!m.active) {
        m.timer -= delta;
        if (m.timer <= 0) {
          m.active = true;
          m.position.set(
            (Math.random() - 0.5) * 100,
            20 + Math.random() * 20,
            -80 - Math.random() * 50
          );
          m.velocity.set(
            (Math.random() - 0.5) * 0.5,
            -0.2 - Math.random() * 0.2,
            0.8 + Math.random() * 0.5
          ).multiplyScalar(2);
        }
        mesh.visible = false;
      } else {
        mesh.visible = true;
        m.position.add(m.velocity);
        mesh.position.copy(m.position);

        if (m.position.y < -5 || m.position.z > 50) {
          m.active = false;
          m.timer = 5 + Math.random() * 10;
        }
      }
    });
  });

  return (
    <group>
      {meteors.map((m, i) => (
        <mesh 
          key={i} 
          ref={(el) => { if (el) refs.current[i] = el; }} 
          scale={m.scale}
        >
          <sphereGeometry args={[1, 8, 8]} />
          <meshStandardMaterial 
            color="#ffffff" 
            emissive="#ffffff" 
            emissiveIntensity={10} 
          />
        </mesh>
      ))}
    </group>
  );
};

const Scene = () => {
  const shipRef = useRef<THREE.Mesh>(null);
  const starsRef = useRef<THREE.Group>(null);
  const shipVirtualPos = useRef(new THREE.Vector2(0, 0));
  const sceneOriginVirtualPos = useRef(new THREE.Vector2(0, 0));
  const virtualAngle = useRef(0);
  const cameraAngle = useRef(0);

  const [alertState, setAlertState] = useState<'none' | 'approaching' | 'active'>('none');
  const alertStateRef = useRef<'none' | 'approaching' | 'active'>('none');
  const nextGlobalDangerTime = useRef(15 + Math.random() * 10);
  const globalDangerBoundsRef = useRef(new THREE.Vector2(-99999, -99999));

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const time = state.clock.getElapsedTime();
    
    // Global Danger Logic
    if (time >= nextGlobalDangerTime.current) {
        nextGlobalDangerTime.current = time + 45 + Math.random() * 30;
        
        const distanceToStart = 300;
        const zoneLength = 200 + Math.random() * 200;
        
        const startY = Math.floor((shipVirtualPos.current.y + distanceToStart) / 4.0) * 4.0;
        const endY = startY + zoneLength;
        
        globalDangerBoundsRef.current.set(startY, endY);
    }
    
    const currentY = shipVirtualPos.current.y;
    const bounds = globalDangerBoundsRef.current;
    
    let newAlertState: 'none' | 'approaching' | 'active' = 'none';
    if (currentY >= bounds.x && currentY <= bounds.y) {
        newAlertState = 'active';
    } else if (currentY >= bounds.x - 250 && currentY < bounds.x) {
        newAlertState = 'approaching';
    }
    
    if (newAlertState !== alertStateRef.current) {
        alertStateRef.current = newAlertState;
        setAlertState(newAlertState);
    }
    
    // 1. Calculate the objective canyon path at the ship's position
    const z = shipVirtualPos.current.y;
    const canyonX = Math.sin(z * 0.002) * 200.0 + Math.sin(z * 0.005) * 50.0;
    const canyonDx = 0.4 * Math.cos(z * 0.002) + 0.25 * Math.cos(z * 0.005);
    
    // 2. Ship Steering
    const targetAngle = Math.atan(canyonDx);
    const offsetX = canyonX - shipVirtualPos.current.x;
    const steerAngle = targetAngle + offsetX * 0.02;
    
    // Update ship heading
    virtualAngle.current += (steerAngle - virtualAngle.current) * dt * 2.0;
    
    // 3. Camera Heading (lags behind ship heading)
    // This creates the "moving towards viewer" effect with a slight lag on turns
    cameraAngle.current += (virtualAngle.current - cameraAngle.current) * dt * 1.5;
    
    // 4. Movement
    const speed = SPEED * 2.5;
    shipVirtualPos.current.x += Math.sin(virtualAngle.current) * speed * dt;
    shipVirtualPos.current.y += Math.cos(virtualAngle.current) * speed * dt;
    
    // The scene origin (0,0,0) is 20 units behind the ship's nose in the scene (z=-20)
    // We calculate its virtual position based on the camera's current heading
    sceneOriginVirtualPos.current.x = shipVirtualPos.current.x - Math.sin(cameraAngle.current) * 20;
    sceneOriginVirtualPos.current.y = shipVirtualPos.current.y - Math.cos(cameraAngle.current) * 20;
    
    const turnRate = (steerAngle - virtualAngle.current);

    if (shipRef.current) {
      // Ship banking and rotation relative to camera view
      const relativeAngle = virtualAngle.current - cameraAngle.current;
      shipRef.current.rotation.y = -relativeAngle;
      shipRef.current.rotation.z = -turnRate * 4.0;
      shipRef.current.rotation.x = -0.2;
    }

    // 5. Dynamic Camera Effects
    const cameraTargetYRot = -turnRate * 0.3;
    const cameraTargetZRot = -turnRate * 0.5;
    state.camera.rotation.y += (cameraTargetYRot - state.camera.rotation.y) * dt * 2.0;
    state.camera.rotation.z += (cameraTargetZRot - state.camera.rotation.z) * dt * 2.0;
    state.camera.rotation.x = -0.3;

    // 6. Rotate Stars to match virtual world
    if (starsRef.current) {
      starsRef.current.rotation.y = cameraAngle.current;
    }
  });

  return (
    <>
      <color attach="background" args={['#050505']} />
      <fog attach="fog" args={['#050505', 20, 140]} />
      
      <PerspectiveCamera makeDefault position={[0, 18, 35]} fov={60} rotation={[-0.3, 0, 0]}>
        <group ref={starsRef}>
          <Stars radius={150} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        </group>
        
        <Float speed={4} rotationIntensity={0.5} floatIntensity={0.5}>
          <mesh ref={shipRef} position={[0, -4, -20]}>
            <coneGeometry args={[0.5, 2, 4]} />
            <meshStandardMaterial color="#00ffff" emissive="#00ffff" emissiveIntensity={5} />
          </mesh>
        </Float>
      </PerspectiveCamera>
      
      <ambientLight intensity={0.2} />
      <pointLight position={[10, 10, 10]} intensity={1} color="#00ffff" />
      <pointLight position={[-10, 10, 10]} intensity={1} color="#ff00ff" />

      <Meteors />
      <Terrain virtualPos={sceneOriginVirtualPos} cameraAngle={cameraAngle} shipVirtualPos={shipVirtualPos} globalDangerBoundsRef={globalDangerBoundsRef} />

      {alertState !== 'none' && (
        <Html center zIndexRange={[100, 0]}>
          <div className="pointer-events-none select-none flex items-center justify-center">
            <h1 className="text-red-600 text-7xl md:text-9xl font-black tracking-[0.2em] animate-pulse" style={{ textShadow: '0 0 40px rgba(220, 38, 38, 0.8), 0 0 80px rgba(220, 38, 38, 0.4)', fontFamily: 'monospace' }}>
              ALERT
            </h1>
          </div>
        </Html>
      )}

      <EffectComposer>
        <Bloom 
          intensity={1.5} 
          luminanceThreshold={0.1} 
          luminanceSmoothing={0.9} 
          height={300} 
        />
        <Noise opacity={0.05} />
        <Vignette eskil={false} offset={0.1} darkness={1.1} />
        <Glitch 
          active={alertState === 'active'} 
          delay={new THREE.Vector2(0.05, 0.2)} 
          duration={new THREE.Vector2(0.05, 0.2)} 
          strength={new THREE.Vector2(0.02, 0.08)} 
        />
      </EffectComposer>
    </>
  );
};

const HUD = () => {
  const [speed, setSpeed] = useState(420);
  const [altitude, setAltitude] = useState(1200);

  useEffect(() => {
    const interval = setInterval(() => {
      setSpeed(s => s + (Math.random() - 0.5) * 2);
      setAltitude(a => a + (Math.random() - 0.5) * 5);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-8 font-mono text-cyan-400 uppercase tracking-widest">
      {/* Top Bar */}
      <div className="flex justify-between items-start">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs opacity-60">
            <Navigation size={14} />
            <span>System Status: Optimal</span>
          </div>
          <motion.div 
            className="text-2xl font-bold flex items-center gap-3"
            animate={{ 
              textShadow: [
                "0 0 0px rgba(0,255,255,0)",
                "2px 0 5px rgba(0,255,255,0.5)",
                "-2px 0 5px rgba(255,0,255,0.5)",
                "0 0 0px rgba(0,255,255,0)"
              ]
            }}
            transition={{ repeat: Infinity, duration: 2, times: [0, 0.1, 0.2, 1] }}
          >
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
            NEON_FLIGHT_OS v2.5
          </motion.div>
        </div>
        <div className="text-right">
          <div className="text-xs opacity-60 mb-1">Coordinates</div>
          <div className="text-sm">X: 124.52 Y: 882.11 Z: --.---</div>
        </div>
      </div>

      {/* Center Crosshair */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
        <div className="w-12 h-12 border border-cyan-400/30 rounded-full flex items-center justify-center">
          <div className="w-1 h-1 bg-cyan-400 rounded-full" />
        </div>
        <div className="absolute w-24 h-[1px] bg-cyan-400/20" />
        <div className="absolute h-24 w-[1px] bg-cyan-400/20" />
      </div>

      {/* Bottom Bar */}
      <div className="grid grid-cols-3 gap-8 items-end">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Gauge size={20} className="text-magenta-500" />
            <div>
              <div className="text-[10px] opacity-60">Velocity</div>
              <div className="text-xl font-bold">{speed.toFixed(0)} <span className="text-xs">KM/H</span></div>
            </div>
          </div>
          <div className="w-full h-1 bg-cyan-900/30 rounded-full overflow-hidden">
            <motion.div 
              className="h-full bg-cyan-400"
              animate={{ width: `${(speed / 600) * 100}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <div className="text-[10px] opacity-60">Altitude Control</div>
          <div className="flex gap-1">
            {[...Array(10)].map((_, i) => (
              <div 
                key={i} 
                className={`w-1 h-4 ${i < 6 ? 'bg-cyan-400' : 'bg-cyan-900/30'}`} 
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col items-end gap-4">
          <div className="flex items-center gap-3 text-right">
            <div>
              <div className="text-[10px] opacity-60">Altitude</div>
              <div className="text-xl font-bold">{altitude.toFixed(0)} <span className="text-xs">M</span></div>
            </div>
            <Wind size={20} />
          </div>
          <div className="w-full h-1 bg-magenta-900/30 rounded-full overflow-hidden">
            <motion.div 
              className="h-full bg-magenta-500"
              initial={{ width: '0%' }}
              animate={{ width: '75%' }}
            />
          </div>
        </div>
      </div>

      {/* Side Accents */}
      <div className="absolute left-4 top-1/4 bottom-1/4 w-[1px] bg-gradient-to-b from-transparent via-cyan-400/30 to-transparent" />
      <div className="absolute right-4 top-1/4 bottom-1/4 w-[1px] bg-gradient-to-b from-transparent via-cyan-400/30 to-transparent" />
    </div>
  );
};

export default function App() {
  return (
    <div className="relative w-full h-screen bg-black overflow-hidden">
      {/* 3D Canvas */}
      <Canvas shadows dpr={[1, 2]}>
        <Scene />
      </Canvas>

      {/* UI Overlay */}
      <HUD />

      {/* Background Glow */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_50%,rgba(0,255,255,0.05),transparent_70%)]" />
      
      {/* Scanline Effect */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
    </div>
  );
}
