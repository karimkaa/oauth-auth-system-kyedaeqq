import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const API_URL = 'http://127.0.0.1:5000';
let currentUserEmail = null;


document.addEventListener('DOMContentLoaded', () => {


    if (typeof THREE === 'undefined') { console.error('Three.js not loaded'); return; }

    // ─── Renderer ─────────────────────────────────────────────────────────────
    const canvas = document.getElementById('particleCanvas');
    const W = window.innerWidth, H = window.innerHeight;

    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true, 
        alpha: false,
        powerPreference: 'high-performance'
    });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio > 1 ? 1.5 : 1);
    renderer.setClearColor(0x00000a);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = false;

    // Dynamic Quality
    function setQuality(isLow) {
        if (isLow) {
            renderer.setPixelRatio(0.6);
        } else {
            renderer.setPixelRatio(window.devicePixelRatio > 1 ? 1.5 : 1);
        }
    }

    const scene  = new THREE.Scene();
    // Camera Setup
    const camera = new THREE.PerspectiveCamera(25, W / H, 0.1, 5000);
    camera.position.set(0, 0.3, 4.0);
    camera.lookAt(0, 0, 0);

    // Optimization Helpers
    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _v3 = new THREE.Vector3();

    // ─── Sun direction ────────────────────────────────────────────────────────
    // Sun in front-right of camera so the Earth face towards us is LIT
    const SUN = new THREE.Vector3(0.4, 0.5, 1.0).normalize();

    // ─── Texture loader helper ────────────────────────────────────────────────
    const texLoader = new THREE.TextureLoader();
    function loadTex(path) {
        const t = texLoader.load(path);
        t.anisotropy     = renderer.capabilities.getMaxAnisotropy();
        t.minFilter      = THREE.LinearMipmapLinearFilter;
        t.magFilter      = THREE.LinearFilter;
        t.generateMipmaps = true;
        return t;
    }

    // ─── 8K day texture from the FBX model pack ───────────────────────────────
    const earthTex8K = loadTex('./models/textures/1_earth_8k.jpg');

    // ─── Night lights (fallback from our textures folder) ────────────────────
    const nightTex   = loadTex('./textures/earth-night.jpg');
    const cloudTex   = loadTex('./textures/earth-clouds.png');
    const waterTex   = loadTex('./textures/earth-water.png');
    const topoTex    = loadTex('./textures/earth-topology.png');

    // ─── Custom PBR ShaderMaterial (applied to FBX geometry) ─────────────────
    const earthMat = new THREE.ShaderMaterial({
        uniforms: {
            dayMap:   { value: earthTex8K },
            nightMap: { value: nightTex   },
            cloudMap: { value: cloudTex   },
            waterMap: { value: waterTex   },
            topoMap:  { value: topoTex    },
            sunDir:   { value: SUN        },
            camPos:   { value: camera.position.clone() }
        },
        vertexShader: `
            varying vec2 vUV;
            varying vec3 vNorm;
            varying vec3 vWorld;
            void main(){
                vUV   = uv;
                vNorm = normalize(normalMatrix * normal);
                vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;

            uniform sampler2D dayMap, nightMap, cloudMap, waterMap, topoMap;
            uniform vec3 sunDir, camPos;

            varying vec2 vUV;
            varying vec3 vNorm, vWorld;

            // ACESFilmic tone mapping
            vec3 ACESFilmic(vec3 x){
                return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
            }

            // GGX microfacet specular
            float GGX(vec3 N, vec3 H, float rough){
                float a  = rough * rough;
                float a2 = a * a;
                float NdH   = max(0.0, dot(N, H));
                float denom = NdH*NdH*(a2-1.0)+1.0;
                return a2 / (3.14159265 * denom * denom + 0.0001);
            }

            // Schlick Fresnel
            float Fresnel(vec3 V, vec3 N, float F0){
                float c = 1.0 - max(0.0, dot(V, N));
                return F0 + (1.0-F0)*c*c*c*c*c;
            }

            void main(){
                vec3 viewDir = normalize(camPos - vWorld);

                // 8-tap Sobel bump from elevation map
                vec2 ts = vec2(1.0/8192.0, 1.0/4096.0);
                float hTL=texture2D(topoMap,vUV+vec2(-ts.x, ts.y)).r;
                float hT =texture2D(topoMap,vUV+vec2(  0.0, ts.y)).r;
                float hTR=texture2D(topoMap,vUV+vec2( ts.x, ts.y)).r;
                float hL =texture2D(topoMap,vUV+vec2(-ts.x,  0.0)).r;
                float hR =texture2D(topoMap,vUV+vec2( ts.x,  0.0)).r;
                float hBL=texture2D(topoMap,vUV+vec2(-ts.x,-ts.y)).r;
                float hB =texture2D(topoMap,vUV+vec2(  0.0,-ts.y)).r;
                float hBR=texture2D(topoMap,vUV+vec2( ts.x,-ts.y)).r;
                float dX = -hTL-2.0*hL-hBL + hTR+2.0*hR+hBR;
                float dY = -hTL-2.0*hT-hTR + hBL+2.0*hB+hBR;
                vec3 N   = normalize(vNorm + vec3(dX, dY, 0.0) * 1.6);

                // Lighting
                float NdotL = dot(N, sunDir);
                float diff   = max(0.0, NdotL);
                float dayMix = smoothstep(-0.15, 0.28, NdotL);

                // 8K day texture — sRGB to linear
                vec3 day = texture2D(dayMap, vUV).rgb;
                day = pow(day, vec3(2.2));
                // Vibrance
                float lum = dot(day, vec3(0.299, 0.587, 0.114));
                day = mix(vec3(lum), day, 1.35);

                // Clouds & water
                float cld   = texture2D(cloudMap, vUV).r;
                float water = texture2D(waterMap, vUV).r;

                // Day illumination — boosted ambient + diffuse
                vec3 dayCol = day * (0.08 + diff * 1.20);

                // Cloud shadow
                float cldShadow = texture2D(cloudMap, vUV + sunDir.xy * 0.007).r;
                dayCol *= 1.0 - cldShadow * 0.45 * diff;

                // GGX ocean specular + Fresnel
                vec3  halfV  = normalize(sunDir + viewDir);
                float spec   = GGX(N, halfV, 0.07);
                float fres   = Fresnel(viewDir, halfV, 0.04);
                dayCol += vec3(0.90, 0.96, 1.00) * spec * fres * water * diff * 0.35;

                // Cloud layer
                dayCol = mix(dayCol, vec3(1.00,0.995,0.98)*(0.04+diff*1.10), cld*0.90);

                // Night city lights
                vec3 nightCol = texture2D(nightMap, vUV).rgb;
                nightCol = pow(nightCol, vec3(2.2));
                nightCol *= 5.0 * (1.0 - cld * 0.7);

                // Blend day / night
                vec3 col = mix(nightCol, dayCol, dayMix);

                // Terminator glow
                col += vec3(1.0, 0.50, 0.12) * exp(-NdotL*NdotL*50.0) * 0.55;
                col += vec3(0.10,0.30, 0.80) * exp(-NdotL*NdotL*200.0)* 0.14;

                // Rayleigh rim scatter
                float cosV = max(0.0, dot(vNorm, viewDir));
                float rim  = pow(1.0 - cosV, 3.5);
                col += vec3(0.15, 0.40, 1.00) * rim * max(0.0, dot(vNorm, sunDir)) * 0.25;

                // Tone mapping + gamma out
                col = ACESFilmic(col * 1.05);
                col = pow(col, vec3(1.0/2.2));

                gl_FragColor = vec4(col, 1.0);
            }
        `
    });

    // ─── FBX Loader ───────────────────────────────────────────────────────────
    let earthGroup = null;
    let clouds     = null;

    const fbxLoader = new FBXLoader();
    fbxLoader.load(
            './models/source/Earth.fbx',
            (fbx) => {
                // Apply our 8K texture to all meshes using MeshStandardMaterial
                fbx.traverse(child => {
                    if (child.isMesh) {
                        const stdMat = new THREE.MeshStandardMaterial({
                            map:         earthTex8K,
                            roughness:   0.65,
                            metalness:   0.0,
                            envMapIntensity: 0.5
                        });
                        
                        // Night cities shader setup
                        stdMat.onBeforeCompile = (shader) => {
                            shader.uniforms.tNight = { value: nightTex };
                            shader.uniforms.tClouds = { value: cloudTex };
                            shader.uniforms.sunDirView = { value: new THREE.Vector3() };
                            stdMat.userData.shader = shader; // Store for animate()

                            // Pass UVs
                            shader.vertexShader = `
                                varying vec2 vMyUv;
                                ${shader.vertexShader}
                            `;
                            shader.vertexShader = shader.vertexShader.replace(
                                '#include <uv_vertex>',
                                `
                                #include <uv_vertex>
                                vMyUv = uv;
                                `
                            );

                            shader.fragmentShader = `
                                uniform sampler2D tNight;
                                uniform sampler2D tClouds;
                                uniform vec3 sunDirView;
                                varying vec2 vMyUv;
                                ${shader.fragmentShader}
                            `;
                            shader.fragmentShader = shader.fragmentShader.replace(
                                '#include <dithering_fragment>',
                                `
                                #include <dithering_fragment>
                                // Day/night mix
                                float intensity = dot(vNormal, sunDirView);
                                float nightMix = smoothstep(0.0, -0.2, intensity);
                                
                                // Read city map
                                vec3 nightCol = texture2D(tNight, vMyUv).rgb;
                                float cld = texture2D(tClouds, vMyUv).r;
                                
                                // Boost lights
                                nightCol = pow(nightCol, vec3(2.2)) * 15.0 * (1.0 - cld * 0.8);
                                
                                // Apply night lights
                                gl_FragColor.rgb += nightCol * nightMix;
                                `
                            );
                        };

                        child.material = stdMat;
                        child.castShadow    = true;
                        child.receiveShadow = true;
                        
                        // Store meshes for animation
                        if (!window.earthCityMeshes) window.earthCityMeshes = [];
                        window.earthCityMeshes.push(child);
                    }
                });

                // Auto-scale to radius ≈ 1
                const box  = new THREE.Box3().setFromObject(fbx);
                const size = new THREE.Vector3();
                box.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                fbx.scale.setScalar(2.0 / maxDim); // diameter = 2 → radius = 1

                // Center
                const center = new THREE.Vector3();
                box.getCenter(center);
                fbx.position.sub(center.multiplyScalar(2.0 / maxDim));

                earthGroup = fbx;
                scene.add(fbx);

                // Reposition camera — show Earth as a globe from orbit
                camera.position.set(0, 0.3, 4.0);
                camera.lookAt(0, 0, 0);

                // Rotate to show Eurasia/Africa by default
                fbx.rotation.y = Math.PI * 0.6;

                // Add atmosphere & clouds after FBX is ready
                addAtmosphere();
                addClouds();
                addHurricanes();
                addStars();
                addMoon();

                // Smooth loader fade out
                const loader = document.getElementById('pageLoader');
                if (loader) {
                    // 3s timeout
                    loader.style.opacity = '0';
                    setTimeout(() => loader.remove(), 3000);
                    
                    // Delay UI
                    setTimeout(() => {
                        const containerUI = document.querySelector('.container');
                        if (containerUI) containerUI.classList.remove('initial-hide');
                    }, 1200);
                }

                console.log('Earth FBX loaded successfully');
            },
            (xhr) => {
                const pct = Math.round(xhr.loaded / xhr.total * 100);
                console.log(`Loading FBX: ${pct}%`);
            },
            (err) => {
                console.error('FBX load error:', err);
                buildFallbackEarth();
            }
        );

    // ─── Fallback: plain SphereGeometry if FBX fails ─────────────────────────
    function buildFallbackEarth() {
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1, 512, 512),
            new THREE.MeshStandardMaterial({ map: earthTex8K, roughness: 0.65, metalness: 0.0 })
        );
        earthGroup = new THREE.Group();
        earthGroup.add(sphere);
        scene.add(earthGroup);
        camera.position.set(0, 0.3, 2.8);
        camera.lookAt(0, 0, 0);
        addAtmosphere();
        addClouds();
        addStars();
        addMoon();
    }

    // ─── Moon Loader ──────────────────────────────────────────────────────────
    let moonPivot = new THREE.Group();
    scene.add(moonPivot);
    
    function addMoon() {
        const moonTex = loadTex('./moon/Textures/Diffuse_2K.png');
        const moonBump = loadTex('./moon/Textures/Bump_2K.png');
        
        fbxLoader.load(
            './moon/Moon 2K.fbx',
            (fbx) => {
                fbx.traverse(child => {
                    if (child.isMesh) {
                        child.material = new THREE.MeshStandardMaterial({
                            map: moonTex,
                            bumpMap: moonBump,
                            bumpScale: 0.005,
                            roughness: 0.9,
                            metalness: 0.0
                        });
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                // Auto-scale to Moon's relative size (Moon radius is ~0.2724 of Earth)
                const box  = new THREE.Box3().setFromObject(fbx);
                const size = new THREE.Vector3();
                box.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                const moonRadius = 0.2724; 
                fbx.scale.setScalar((2.0 / maxDim) * moonRadius);

                // Center
                const center = new THREE.Vector3();
                box.getCenter(center);
                fbx.position.sub(center.multiplyScalar((2.0 / maxDim) * moonRadius));

                const moonGroup = new THREE.Group();
                moonGroup.add(fbx);
                
                // Moon position
                moonGroup.position.set(2.5, 0.2, -0.5);
                moonPivot.add(moonGroup);
                
                // Tilt the moon orbit slightly (around 5.14 degrees)
                moonPivot.rotation.z = 5.14 * Math.PI / 180;

                console.log('Moon FBX loaded successfully');
            },
            undefined,
            (err) => console.error('Moon FBX load error:', err)
        );
    }

    // ─── Cloud shell ──────────────────────────────────────────────────────────
    let clouds1 = null, clouds2 = null;
    function addClouds() {
        const cloudMat = new THREE.MeshPhongMaterial({
            map: cloudTex,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        
        const cloudGeo = new THREE.SphereGeometry(1, 32, 32);
        clouds1 = new THREE.Mesh(cloudGeo, cloudMat);
        clouds1.scale.setScalar(1.006);
        
        clouds2 = new THREE.Mesh(cloudGeo, cloudMat.clone());
        clouds2.scale.setScalar(1.012);
        
        // Clouds rotation
        clouds2.rotation.x = Math.PI / 4;
        clouds2.rotation.y = Math.PI / 2;

        scene.add(clouds1);
        scene.add(clouds2);
    }

    // ─── Night Lights ───────────────────────────────────
    

    // ─── Hurricanes ─────────────────────────────────────────
    const hurricanes = [];
    function addHurricanes() {
        const hurrGeo = new THREE.PlaneGeometry(0.25, 0.25);
        const hurrMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0.0 },
                opacity: { value: 0.0 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float time;
                uniform float opacity;
                varying vec2 vUv;
                void main() {
                    vec2 uv = vUv - 0.5;
                    float dist = length(uv);
                    if (dist > 0.5) discard;
                    
                    float angle = atan(uv.y, uv.x);
                    // Cyclone spiral
                    float spiral = sin(12.0 * dist - angle * 3.0 - time * 6.0);
                    float alpha = smoothstep(0.5, 0.0, dist) * smoothstep(-1.0, 1.0, spiral);
                    
                    gl_FragColor = vec4(0.9, 0.95, 1.0, alpha * opacity);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        for (let i = 0; i < 5; i++) {
            const mesh = new THREE.Mesh(hurrGeo, hurrMat.clone());
            const pivot = new THREE.Group();
            
            // Distribute on sphere
            const phi = Math.acos( -1 + ( 2 * Math.random() ) );
            const theta = Math.sqrt( 7000 * Math.PI ) * phi;
            // Above clouds
            mesh.position.setFromSphericalCoords(1.018, phi, theta);
            mesh.lookAt(0,0,0);
            
            pivot.add(mesh);
            if (earthGroup) {
                earthGroup.add(pivot);
            } else {
                scene.add(pivot);
            }
            
            hurricanes.push({
                mesh: mesh,
                life: Math.random() * Math.PI * 2,
                speed: 0.002 + Math.random() * 0.002
            });
        }
    }

    // ─── Atmosphere (Smooth gradient halo) ────────────────────────────────────
    let atmMesh1 = null;
    function addAtmosphere() {
        const atmMat = new THREE.ShaderMaterial({
            uniforms: { sunDir: { value: SUN } },
            vertexShader: `
                varying vec3 vNormal;
                varying vec3 vPosition;
                void main(){
                    vNormal = normalize(normalMatrix * normal);
                    vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
                    gl_Position = projectionMatrix * vec4(vPosition, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 sunDir;
                varying vec3 vNormal;
                varying vec3 vPosition;
                void main(){
                    vec3 viewDir = normalize(-vPosition);
                    float NdotV = max(dot(vNormal, viewDir), 0.0);
                    float rim = 1.0 - NdotV; 
                    
                    // Atmosphere rim
                    
                    float alpha = smoothstep(1.0, 0.6, rim);
                    alpha = pow(alpha, 2.0); 
                    
                    float sunDot = dot(vNormal, sunDir);
                    float sunMix = smoothstep(-0.2, 0.8, sunDot);
                    
                    // Atmosphere color
                    vec3 color = mix(vec3(0.02, 0.05, 0.15), vec3(0.2, 0.5, 1.0), sunMix);
                    
                    // Glow
                    float glow = smoothstep(0.2, 1.0, sunDot) * 0.15; 
                    color += vec3(0.1, 0.2, 0.4) * glow; 
                    
                    gl_FragColor = vec4(color, alpha * (sunMix * 0.65 + glow));
                }
            `,
            side: THREE.FrontSide,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false
        });
        // 32x32 segments
        atmMesh1 = new THREE.Mesh(new THREE.SphereGeometry(1.05, 32, 32), atmMat);
        scene.add(atmMesh1);
    }

    // ─── Stars ────────────────────────────────────────────────────────────────
    function addStars() {
        const sv = [];
        const phases = [];
        for (let i = 0; i < 7000; i++) {
            const th = Math.random() * Math.PI * 2;
            const ph = Math.acos(2 * Math.random() - 1);
            const r  = 80 + Math.random() * 30;
            sv.push(r*Math.sin(ph)*Math.cos(th), r*Math.cos(ph), r*Math.sin(ph)*Math.sin(th));
            phases.push(Math.random() * Math.PI * 2);
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
        sg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
        // Stars shader
        const starsMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0.0 }
            },
            vertexShader: `
                uniform float time;
                attribute float aPhase;
                varying float vAlpha;
                void main() {
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    // Smooth fade:
                    
                    
                    
                    float t = sin(time * 0.5 + aPhase); 
                    float twinkle = smoothstep(-0.5, 0.5, t); 
                    vAlpha = twinkle;
                    gl_PointSize = 120.0 / -mvPosition.z;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                void main() {
                    // Soft circle
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    if (length(coord) > 0.5) discard;
                    gl_FragColor = vec4(0.85, 0.90, 1.0, vAlpha);
                }
            `,
            transparent: true,
            depthWrite: false
        });

        const points = new THREE.Points(sg, starsMaterial);
        points.name = 'stars';
        window.starsObj = points; // Cache reference
        scene.add(points);
    }

    // ─── Lighting ─────────────────────────────────────────────────────────────
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    sunLight.position.copy(SUN).multiplyScalar(20);
    sunLight.castShadow = false; // Disable shadow
    sunLight.shadow.mapSize.width = 1024; // Optimization
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 50;
    sunLight.shadow.camera.left = -5;
    sunLight.shadow.camera.right = 5;
    sunLight.shadow.camera.top = 5;
    sunLight.shadow.camera.bottom = -5;
    sunLight.shadow.bias = -0.0005;

    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x112244, 2.0));

    // ─── Resize ───────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // ─── Animation loop ──────────────────
    let running = true;
    let starsTime = 0;
    let sunAngle = 0.5;

    document.addEventListener('visibilitychange', () => { running = !document.hidden; });

    (function animate() {
        requestAnimationFrame(animate);
        if (!running) return;

        starsTime += 0.016;
        if (window.starsObj) {
            window.starsObj.material.uniforms.time.value = starsTime;
        }

        const earthRotationSpeed = 0.000050;

        if (earthGroup) earthGroup.rotation.y += earthRotationSpeed;
        if (clouds1) clouds1.rotation.y += earthRotationSpeed * 1.1;
        if (clouds2) clouds2.rotation.y += earthRotationSpeed * 1.4;
        
        if (moonPivot) moonPivot.rotation.y += earthRotationSpeed * 5.0; 

        hurricanes.forEach(h => {
            h.life += h.speed;
            h.mesh.material.uniforms.time.value = starsTime;
            h.mesh.material.uniforms.opacity.value = Math.max(0, Math.sin(h.life)) * 0.55;
        });

        // Optimized sun calculation
        sunAngle -= 0.0001;
        _v1.set(Math.sin(sunAngle), 0.3, Math.cos(sunAngle)).normalize();
        sunLight.position.copy(_v1).multiplyScalar(20);
        
        // View space sun direction
        _v2.copy(_v1).transformDirection(camera.matrixWorldInverse);

        if (atmMesh1) {
            atmMesh1.material.uniforms.sunDir.value.copy(_v2);
        }
        
        // Optimized mesh traversal
        if (window.earthCityMeshes) {
            for (let i = 0; i < window.earthCityMeshes.length; i++) {
                const child = window.earthCityMeshes[i];
                if (child.material && child.material.userData && child.material.userData.shader) {
                    child.material.userData.shader.uniforms.sunDirView.value.copy(_v2);
                }
            }
        }

        renderer.render(scene, camera);
    })();

    // ─── Idle UI Fade Out ─────────────────────────────────────────────────────
    let idleTimer = null;
    const containerUI = document.querySelector('.container');
    
    function resetIdleTimer() {
        if (!containerUI) return;
        if (containerUI.classList.contains('ui-idle')) {
            containerUI.classList.remove('ui-idle');
        }
        clearTimeout(idleTimer);
        // Hide UI after 20s
        idleTimer = setTimeout(() => {
            containerUI.classList.add('ui-idle');
        }, 20000); 
    }
    
    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('touchstart', resetIdleTimer);
    resetIdleTimer();

    // ═══════════════════════════════════════════════════════════════════════════
    //  App logic
    // ═══════════════════════════════════════════════════════════════════════════
    const loginSection    = document.getElementById('loginSection');
    const registerSection = document.getElementById('registerSection');
    const profileSection  = document.getElementById('profileSection');
    const forgotSection   = document.getElementById('forgotPasswordSection');
    const resetSection    = document.getElementById('resetPasswordSection');

    function showSection(section, title) {
        [loginSection, registerSection, profileSection, forgotSection, resetSection].forEach(s => s.classList.remove('active'));
        section.classList.add('active');
        document.title = title;
        clearMessages();
    }

    const regAvatarContainer = document.getElementById('regAvatarContainer');
    const regAvatarFile = document.getElementById('regAvatarFile');
    const regAvatarImage = document.getElementById('regAvatarImage');
    const regAvatarIcon = document.getElementById('regAvatarIcon');

    if (regAvatarContainer && regAvatarFile) {
        regAvatarContainer.addEventListener('click', () => regAvatarFile.click());

        regAvatarFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    regAvatarImage.src = event.target.result;
                    regAvatarImage.style.display = 'block';
                    regAvatarIcon.style.display = 'none';
                };
                reader.readAsDataURL(file);
            }
        });
    }

    document.getElementById('showRegister').addEventListener('click', e => {
        e.preventDefault(); showSection(registerSection, 'Регистрация | Premium Project');
    });
    document.getElementById('showLogin').addEventListener('click', e => {
        e.preventDefault(); showSection(loginSection, 'Вход | Premium Project');
    });
    document.getElementById('showForgotPassword').addEventListener('click', e => {
        e.preventDefault(); showSection(forgotSection, 'Восстановление пароля | Premium Project');
    });
    document.getElementById('showLoginFromForgot').addEventListener('click', e => {
        e.preventDefault(); showSection(loginSection, 'Вход | Premium Project');
    });
    document.getElementById('showLoginFromReset').addEventListener('click', e => {
        e.preventDefault(); showSection(loginSection, 'Вход | Premium Project');
    });

    document.getElementById('btnLogout').addEventListener('click', () => {
        currentUserEmail = null;
        document.getElementById('profileForm').reset();
        document.getElementById('avatarPreview').innerHTML = '<span class="material-symbols-outlined">account_circle</span>';
        showSection(loginSection, 'Вход | Premium Project');
        showMessage('Вы вышли из аккаунта', 'info');
    });

    function loadProfileUI(data) {
        currentUserEmail = data.email;
        currentUserProfileData = data;
        
        // Enter messenger
        initAppInterface(data);
        
        populateSettingsUI();
        document.title = 'Messenger | Premium Project';
        clearMessages();
    }

    // --- Avatar Logic ---
    const avatarContainer = document.getElementById('avatarContainer');
    const avatarMenu      = document.getElementById('avatarMenu');
    const btnViewPhoto    = document.getElementById('btnViewPhoto');
    const btnChangePhoto  = document.getElementById('btnChangePhoto');
    const profAvatarFile  = document.getElementById('profAvatarFile');
    const photoViewer     = document.getElementById('photoViewerModal');
    const cropperModal    = document.getElementById('cropperModal');
    let cropper = null;

    // Toggle menu
    avatarContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        avatarMenu.classList.toggle('active');
    });

    // Close menu
    document.addEventListener('click', () => avatarMenu.classList.remove('active'));

    // View photo
    btnViewPhoto.addEventListener('click', () => {
        const currentSrc = document.querySelector('#avatarPreview img')?.src;
        if (currentSrc) {
            document.getElementById('fullSizePhoto').src = currentSrc;
            photoViewer.classList.add('active');
        } else {
            showMessage('Фотография еще не установлена', 'info');
        }
    });

    // Change photo
    btnChangePhoto.addEventListener('click', () => profAvatarFile.click());

    // File selected
    profAvatarFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            document.getElementById('imageToCrop').src = event.target.result;
            cropperModal.classList.add('active');
            
            if (cropper) cropper.destroy();
            
            // Init Cropper
            const image = document.getElementById('imageToCrop');
            cropper = new Cropper(image, {
                aspectRatio: 1,
                viewMode: 1,
                background: false
            });
        };
        reader.readAsDataURL(file);
    });

    // Save and upload crop
    document.getElementById('saveCrop').addEventListener('click', () => {
        if (!cropper) return;

        cropper.getCroppedCanvas({ width: 400, height: 400 }).toBlob(async (blob) => {
            const formData = new FormData();
            formData.append('avatar', blob, 'avatar.jpg');

            cropperModal.classList.remove('active');
            showMessage('Загрузка аватарки…', 'info');

            try {
                const r = await fetch(`${API_URL}/upload_avatar`, { method: 'POST', body: formData });
                const d = await r.json();
                if (r.ok) {
                    await fetch(`${API_URL}/update_profile`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: currentUserEmail, avatar: d.avatar_url })
                    });
                    currentUserProfileData.avatar = d.avatar_url;
                    populateSettingsUI();
                    document.getElementById('miniAvatar').innerHTML = `<img src="${d.avatar_url}">`;
                    showMessage('Аватарка обновлена!', 'success');
                } else {
                    showMessage(d.error || 'Ошибка загрузки', 'error');
                }
            } catch {
                showMessage('Ошибка сервера', 'error');
            }
        });
    });

    // Cancel crop
    document.getElementById('cancelCrop').addEventListener('click', () => {
        cropperModal.classList.remove('active');
        profAvatarFile.value = '';
    });

    // Close viewer
    photoViewer.addEventListener('click', () => photoViewer.classList.remove('active'));
    document.querySelector('.close-viewer').addEventListener('click', () => photoViewer.classList.remove('active'));

    // --- Messenger Logic ---
    const appInterface = document.getElementById('appInterface');
    const contactsList = document.getElementById('contactsList');
    const chatHistory  = document.getElementById('chatHistory');
    const chatInput    = document.getElementById('chatInput');
    const sendMsgBtn   = document.getElementById('sendMsgBtn');
    const attachmentInput = document.getElementById('attachmentInput');
    const uploadAttachmentBtn = document.getElementById('uploadAttachmentBtn');
    
    // Search Modal Elements
    const searchModal       = document.getElementById('searchModal');
    const openSearchBtn     = document.getElementById('openSearchBtn');
    const userSearchInput   = document.getElementById('userSearchInput');
    const userSearchResults = document.getElementById('userSearchResults');
    
    let currentRecipient = null;
    let chatPollInterval = null;
    let allUsersCache    = []; // For search

    async function initAppInterface(userData) {
        setQuality(true);
        const containerUI = document.querySelector('.container');
        if (containerUI) {
            containerUI.style.opacity = '0';
            containerUI.style.pointerEvents = 'none';
        }
        setTimeout(() => {
            appInterface.classList.add('active');
        }, 400);

        document.getElementById('miniName').textContent = userData.name;
        if (userData.avatar) {
            document.getElementById('miniAvatar').innerHTML = `<img src="${userData.avatar}">`;
        }
        
        fetchActiveContacts();
        fetchAllUsers(); // For search cache
        fetchServers();
    }

    async function fetchActiveContacts() {
        try {
            const r = await fetch(`${API_URL}/get_active_contacts?email=${currentUserEmail}`);
            const users = await r.json();
            if (r.ok) {
                renderActiveContacts(users);
            } else {
                console.error('Server error fetching contacts:', users.error);
                contactsList.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444; text-align: center; margin-top: 50%;">Ошибка сервера</div>';
            }
        } catch (e) {
            console.error('Fetch active contacts error:', e);
            contactsList.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444; text-align: center; margin-top: 50%;">Сетевая ошибка</div>';
        }
    }

    async function fetchAllUsers() {
        try {
            const r = await fetch(`${API_URL}/get_users`);
            const users = await r.json();
            if (r.ok) allUsersCache = users.filter(u => u.email !== currentUserEmail);
        } catch (e) { console.error('Fetch all users error:', e); }
    }

    function renderActiveContacts(users) {
        if (!users || users.length === 0) {
            contactsList.innerHTML = '<div class="contacts-placeholder" style="text-align: center; margin-top: 50%; opacity: 0.7;">Здесь ничего нет, попробуйте начать...</div>';
            return;
        }
        contactsList.innerHTML = users.map(u => {
            const safeAvatar = u.avatar ? u.avatar.replace(/"/g, '&quot;') : '';
            const safeName = u.name.replace(/"/g, '&quot;');
            return `
            <div class="contact-item" data-email="${u.email}" data-name="${safeName}" data-avatar="${safeAvatar}">
                <div class="contact-avatar">
                    ${u.avatar ? `<img src="${u.avatar}">` : '<span class="material-symbols-outlined">person</span>'}
                </div>
                <div class="contact-info">
                    <div class="contact-name">${u.name}</div>
                    <div class="contact-status">В сети</div>
                </div>
            </div>
        `}).join('');
    }

    contactsList.addEventListener('click', (e) => {
        const item = e.target.closest('.contact-item');
        if (!item) return;
        
        const email = item.getAttribute('data-email');
        const name = item.getAttribute('data-name');
        const avatar = item.getAttribute('data-avatar');
        
        window.selectChat(email, name, avatar);
    });

    // Search users
    openSearchBtn.addEventListener('click', () => {
        searchModal.classList.add('active');
        userSearchInput.focus();
    });

    const openSearchBtnPlus = document.getElementById('openSearchBtnPlus');
    if (openSearchBtnPlus) {
        openSearchBtnPlus.addEventListener('click', () => {
            searchModal.classList.add('active');
            userSearchInput.focus();
        });
    }

    searchModal.addEventListener('click', (e) => {
        if (e.target === searchModal) searchModal.classList.remove('active');
    });

    userSearchInput.addEventListener('input', () => {
        const query = userSearchInput.value.toLowerCase().trim();
        if (!query) {
            userSearchResults.innerHTML = '';
            return;
        }
        
        const filtered = allUsersCache.filter(u => 
            u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)
        );
        
        renderSearchResults(filtered);
    });

    function renderSearchResults(users) {
        userSearchResults.innerHTML = users.map(u => {
            const safeAvatar = u.avatar ? u.avatar.replace(/"/g, '&quot;') : '';
            const safeName = u.name.replace(/"/g, '&quot;');
            return `
            <div class="search-result-item" data-email="${u.email}" data-name="${safeName}" data-avatar="${safeAvatar}" style="cursor: pointer;">
                <div class="search-result-avatar">
                    ${u.avatar ? `<img src="${u.avatar}">` : '<span class="material-symbols-outlined">person</span>'}
                </div>
                <div class="search-result-info">
                    <div class="search-result-name">${u.name}</div>
                    <div class="search-result-email">${u.email}</div>
                </div>
            </div>
        `}).join('');
    }

    userSearchResults.addEventListener('click', (e) => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        
        const email = item.getAttribute('data-email');
        const name = item.getAttribute('data-name');
        const avatar = item.getAttribute('data-avatar');
        
        searchModal.classList.remove('active');
        userSearchInput.value = '';
        userSearchResults.innerHTML = '';
        window.selectChat(email, name, avatar);
        fetchActiveContacts(); 
    });

    window.selectChatFromSearch = function(email, name, avatar) {
        searchModal.classList.remove('active');
        userSearchInput.value = '';
        userSearchResults.innerHTML = '';
        window.selectChat(email, name, avatar);
        
        // Update contacts sidebar
        fetchActiveContacts(); 
    };

    let currentServerId = null;
    let currentChannelId = null;
    let serversList = [];

    window.selectChat = function(email, name, avatar) {
        currentRecipient = email;
        currentChannelId = null;
        document.getElementById('chatWelcome').style.display = 'none';
        document.getElementById('activeChat').style.display = 'flex';
        document.getElementById('activeName').textContent = name;
        document.getElementById('activeAvatar').innerHTML = avatar ? `<img src="${avatar}">` : `<span class="material-symbols-outlined" style="color: #949ba4;">person</span>`;
        chatInput.placeholder = `Написать ${name}`;

        const membersSidebar = document.getElementById('membersSidebar');
        if (membersSidebar) membersSidebar.style.display = 'none';

        chatHistory.innerHTML = '<div class="contacts-placeholder">Загрузка сообщений...</div>';
        fetchPrivateMessages();

        if (chatPollInterval) clearInterval(chatPollInterval);
        chatPollInterval = setInterval(pollMessages, 2000);
        
        document.querySelectorAll('.contact-item').forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('data-email') === email) item.classList.add('active');
        });
    };

    function pollMessages() {
        if (currentChannelId) {
            fetchChannelMessages();
        } else if (currentRecipient) {
            fetchPrivateMessages();
        }
    }

    async function fetchPrivateMessages() {
        if (!currentRecipient) return;
        try {
            const r = await fetch(`${API_URL}/get_messages?sender_email=${currentUserEmail}&recipient_email=${currentRecipient}`);
            const msgs = await r.json();
            if (r.ok) {
                renderMessages(msgs, false);
            } else {
                console.error('Server error fetching msgs:', msgs.error);
                chatHistory.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444;">Ошибка сервера: ' + (msgs.error || 'неизвестно') + '</div>';
            }
        } catch (e) {
            console.error('Fetch msgs error:', e);
            chatHistory.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444;">Сетевая ошибка</div>';
        }
    }

    async function fetchChannelMessages() {
        if (!currentChannelId) return;
        try {
            const r = await fetch(`${API_URL}/api/channels/${currentChannelId}/messages`);
            const msgs = await r.json();
            if (r.ok) {
                renderMessages(msgs, true);
            } else {
                console.error('Server error fetching channel msgs:', msgs.error);
                chatHistory.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444;">Ошибка сервера: ' + (msgs.error || 'неизвестно') + '</div>';
            }
        } catch (e) {
            console.error('Fetch channel msgs error:', e);
            chatHistory.innerHTML = '<div class="contacts-placeholder" style="color: #ef4444;">Сетевая ошибка</div>';
        }
    }

    function renderMessages(msgs, isServerChannel) {
        if (msgs.length === 0) {
            chatHistory.innerHTML = `
                <div class="empty-history-notice">
                    <span class="material-symbols-outlined">forum</span>
                    <p>Чат пустой, начните общение!</p>
                </div>
            `;
            return;
        }

        const selfName = document.getElementById('miniName').textContent || 'Вы';
        const selfAvatar = document.getElementById('miniAvatar').querySelector('img')?.src || '';
        const recipientName = document.getElementById('activeName').textContent || 'Собеседник';
        const recipientAvatar = document.getElementById('activeAvatar').querySelector('img')?.src || '';

        let html = '';
        let lastSender = null;
        let lastTime = null;

        window.viewPhoto = function(src) {
            document.getElementById('fullSizePhoto').src = src;
            document.getElementById('photoViewerModal').classList.add('active');
        };

        msgs.forEach(m => {
            const date = new Date(m.time + 'Z');
            const timeStr = date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Parse time difference
            const diff = lastTime ? (date.getTime() - lastTime.getTime()) : Infinity;
            
            const isSelf = (m.sender === currentUserEmail);
            const senderName = isServerChannel ? (m.sender_name || m.sender.split('@')[0]) : (isSelf ? selfName : recipientName);
            const senderAvatarImg = isServerChannel ? m.sender_avatar : (isSelf ? selfAvatar : recipientAvatar);

            // Attachment rendering logic
            let attachmentHTML = '';
            if (m.attachment) {
                const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(m.attachment);
                if (isImg) {
                    attachmentHTML = `
                    <div class="message-attachment" style="margin-top: 8px; max-width: 400px; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.1);">
                        <img src="${m.attachment}" style="max-width: 100%; max-height: 300px; object-fit: contain; cursor: pointer; display: block;" onclick="viewPhoto('${m.attachment}')">
                    </div>
                    `;
                } else {
                    const parts = m.attachment.split('/');
                    const filename = parts[parts.length - 1];
                    attachmentHTML = `
                    <div class="message-attachment" style="margin-top: 8px; display: inline-flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
                        <span class="material-symbols-outlined" style="color: #949ba4;">insert_drive_file</span>
                        <a href="${m.attachment}" target="_blank" style="color: #00b0f4; text-decoration: none; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;">${filename}</a>
                        <span style="font-size: 11px; color: #949ba4; margin-left: 8px;">(Вложение)</span>
                    </div>
                    `;
                }
            }

            // Grouping logic: same sender and within 5 minutes and not a reply
            if (lastSender === m.sender && diff < 5 * 60 * 1000 && !m.parent_id) {
                html += `
                <div class="discord-message grouped-message" data-msg-id="${m.id || ''}" data-sender="${m.sender}" style="margin-top: 0; margin-bottom: 0; padding-top: 2px; padding-bottom: 2px; position: relative;">
                    <div class="discord-message-hover-area" style="position: absolute; left: 0; width: 56px; display: flex; justify-content: flex-end; padding-right: 12px; box-sizing: border-box;">
                        <span class="discord-message-hover-timestamp" style="font-size: 10px; color: #949ba4; opacity: 0; pointer-events: none; transition: opacity 0.1s; margin-top: 3px;">${timeStr}</span>
                    </div>
                    <div class="discord-message-content" style="padding-left: 56px; width: 100%;">
                        <div class="discord-message-text">${m.text}</div>
                        ${attachmentHTML}
                        <div class="message-edit-area"></div>
                    </div>
                </div>
                `;
            } else {
                let replyHTML = '';
                if (m.parent_id) {
                    const parentMsg = msgs.find(pm => pm.id === m.parent_id);
                    if (parentMsg) {
                        const parentSenderName = isServerChannel 
                            ? (parentMsg.sender_name || parentMsg.sender.split('@')[0]) 
                            : (parentMsg.sender === currentUserEmail ? selfName : recipientName);
                        
                        replyHTML = `
                        <div class="discord-message-reply-preview" style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #b5bac1; padding-left: 56px; margin-bottom: 4px; cursor: pointer; opacity: 0.8; user-select: none;" onclick="scrollToMessage(${m.parent_id})">
                            <span class="material-symbols-outlined" style="font-size: 14px; transform: scaleX(-1); color: #b5bac1; vertical-align: middle; line-height: 1;">reply</span>
                            <span style="font-weight: 600; color: #f2f3f5;">@${parentSenderName}</span>
                            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px; color: #949ba4;">${parentMsg.text}</span>
                        </div>
                        `;
                    }
                }
                
                html += `
                <div class="discord-message-container" style="display: flex; flex-direction: column; width: 100%;">
                    ${replyHTML}
                    <div class="discord-message" data-msg-id="${m.id || ''}" data-sender="${m.sender}" style="position: relative;">
                        <div class="discord-message-avatar">
                            ${senderAvatarImg ? `<img src="${senderAvatarImg}">` : '<span class="material-symbols-outlined" style="color: #949ba4; font-size: 24px;">person</span>'}
                        </div>
                        <div class="discord-message-content">
                            <div class="discord-message-header">
                                <span class="discord-message-author">${senderName}</span>
                                <span class="discord-message-timestamp">${timeStr}</span>
                            </div>
                            <div class="discord-message-text">${m.text}</div>
                            ${attachmentHTML}
                            <div class="message-edit-area"></div>
                        </div>
                    </div>
                </div>
                `;
            }

            lastSender = m.sender;
            lastTime = date;
        });

        chatHistory.innerHTML = html;
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    window.scrollToMessage = function(msgId) {
        const el = document.querySelector(`.discord-message[data-msg-id="${msgId}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.transition = 'background-color 0.2s';
            el.style.backgroundColor = 'rgba(88, 101, 242, 0.2)';
            setTimeout(() => {
                el.style.transition = 'background-color 1s ease';
                el.style.backgroundColor = 'transparent';
            }, 1500);
        }
    };

    async function sendMessage(customText = null, attachmentUrl = null) {
        const text = (customText !== null) ? customText : chatInput.value.trim();
        if (!text && !attachmentUrl) return;
        
        const parent_id = replyToData ? replyToData.id : null;
        
        if (currentChannelId) {
            try {
                const r = await fetch(`${API_URL}/api/channels/${currentChannelId}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        sender_email: currentUserEmail, 
                        text: text, 
                        parent_id: parent_id,
                        attachment: attachmentUrl
                    })
                });
                if (r.ok) {
                    if (customText === null) chatInput.value = '';
                    if (replyBar) replyBar.classList.remove('active');
                    replyToData = null;
                    fetchChannelMessages();
                }
            } catch (e) { console.error('Send channel message error:', e); }
        } else if (currentRecipient) {
            try {
                const r = await fetch(`${API_URL}/send_message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        sender_email: currentUserEmail, 
                        recipient_email: currentRecipient, 
                        text: text, 
                        parent_id: parent_id,
                        attachment: attachmentUrl
                    })
                });
                if (r.ok) {
                    if (customText === null) chatInput.value = '';
                    if (replyBar) replyBar.classList.remove('active');
                    replyToData = null;
                    fetchPrivateMessages();
                    fetchActiveContacts(); 
                }
            } catch (e) { console.error('Send message error:', e); }
        }
    }

    sendMsgBtn.addEventListener('click', () => sendMessage());
    chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });

    // --- Attachment Upload Logic ---
    uploadAttachmentBtn.addEventListener('click', () => {
        attachmentInput.click();
    });

    attachmentInput.addEventListener('change', async () => {
        const file = attachmentInput.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const uploadResponse = await fetch(`${API_URL}/api/upload_attachment`, {
                method: 'POST',
                body: formData
            });
            const uploadResult = await uploadResponse.json();
            if (uploadResponse.ok) {
                const fileUrl = uploadResult.file_url;
                const filename = uploadResult.filename;

                // Send the message with attachment
                await sendMessage(filename, fileUrl);
                attachmentInput.value = ''; // reset input
            } else {
                alert('Ошибка загрузки файла: ' + (uploadResult.error || 'неизвестно'));
            }
        } catch (e) {
            console.error('File upload error:', e);
            alert('Сетевая ошибка при загрузке файла');
        }
    });

    // --- Servers and Channels switching logic ---

    // Define mock members globally
    const mockMembersPool = {
        'Google DeepMind': [
            { name: 'Demis Hassabis', role: 'Основатели', status: 'online', statusText: 'Playing Chess with AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Demis' },
            { name: 'Shane Legg', role: 'Основатели', status: 'dnd', statusText: 'AGI is near', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Shane' },
            { name: 'Sundar Pichai', role: 'Руководство', status: 'online', statusText: 'AI first company', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Sundar' },
            { name: 'Geoffrey Hinton', role: 'Исследователи', status: 'offline', statusText: 'Godfather of AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Geoffrey' },
            { name: 'Yann LeCun', role: 'Исследователи', status: 'online', statusText: 'Autoregressive models suck', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yann' },
            { name: 'Yoshua Bengio', role: 'Исследователи', status: 'idle', statusText: 'AI safety advocate', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yoshua' }
        ],
        'Python Developers': [
            { name: 'Guido van Rossum', role: 'Создатель Python', status: 'online', statusText: 'import antigravity', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Guido' },
            { name: 'Raymond Hettinger', role: 'Core Devs', status: 'dnd', statusText: 'There must be a better way', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Raymond' },
            { name: 'Carol Willing', role: 'Core Devs', status: 'online', statusText: 'Jupyter & Python', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Carol' },
            { name: 'Brett Cannon', role: 'Core Devs', status: 'offline', statusText: 'VS Code Python guy', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Brett' }
        ],
        'Antigravity Workspace': [
            { name: 'Antigravity Bot', role: 'Боты', status: 'online', statusText: 'Here to help you code!', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Antigravity' },
            { name: 'Gemini 1.5 Pro', role: 'ИИ Помощники', status: 'online', statusText: 'Google DeepMind model', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Gemini' },
            { name: 'Claude 3 Opus', role: 'ИИ Помощники', status: 'dnd', statusText: 'Constitutional AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Claude' },
            { name: 'GPT-4o', role: 'ИИ Помощники', status: 'online', statusText: 'Omni model', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=GPT' }
        ]
    };

    // Helper to dynamically update the live stats inside server settings preview card
    window.updateSettingsLiveStats = function(server) {
        if (!server) return;
        const members = mockMembersPool[server.name] || [];
        const currentUserName = document.getElementById('miniName').textContent || currentUserEmail.split('@')[0];
        const hasMe = members.some(m => m.name === currentUserName);
        const total = members.length + (hasMe ? 0 : 1);
        const online = members.filter(m => m.status !== 'offline').length + (hasMe ? 1 : 0);
        
        const onlineText = `${online} в сети`;
        let totalText = `${total} участник`;
        if (total > 1 && total < 5) {
            totalText = `${total} участника`;
        } else if (total >= 5 || total === 0) {
            totalText = `${total} участников`;
        }
        
        const onlineEl = document.getElementById('serverSettingsPreviewOnlineCount');
        const totalEl = document.getElementById('serverSettingsPreviewTotalCount');
        if (onlineEl) onlineEl.textContent = onlineText;
        if (totalEl) totalEl.textContent = totalText;
    };

    // Background simulation of members' online/offline statuses
    setInterval(() => {
        if (!currentServerId) return;
        const currentServer = serversList.find(s => s.id === currentServerId);
        if (!currentServer) return;
        
        const members = mockMembersPool[currentServer.name];
        if (!members || members.length === 0) return;
        
        const currentUserName = document.getElementById('miniName').textContent || currentUserEmail.split('@')[0];
        const candidates = members.filter(m => m.name !== currentUserName);
        if (candidates.length === 0) return;
        
        const randomMember = candidates[Math.floor(Math.random() * candidates.length)];
        const statuses = ['online', 'dnd', 'idle', 'offline'];
        const newStatus = statuses[Math.floor(Math.random() * statuses.length)];
        randomMember.status = newStatus;
        
        if (newStatus === 'offline') {
            randomMember.statusText = '';
        } else {
            const activities = ['Пишет код', 'Изучает ИИ', 'Смотрит мемы', 'Анализирует данные', 'Общается в чате'];
            randomMember.statusText = activities[Math.floor(Math.random() * activities.length)];
        }
        
        const membersSidebar = document.getElementById('membersSidebar');
        if (membersSidebar && membersSidebar.style.display !== 'none') {
            updateMembersSidebar(currentServer);
        }
        updateSettingsLiveStats(currentServer);
    }, 8000);

    function updateMembersSidebar(server) {
        const sidebar = document.getElementById('membersSidebar');
        if (!sidebar) return;

        if (!mockMembersPool[server.name]) {
            mockMembersPool[server.name] = [
                { name: server.owner_email.split('@')[0], role: 'Создатель сервера', status: 'online', statusText: 'Владелец сервера', avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${server.owner_email}` },
                { name: 'Yann LeCun', role: 'Участники', status: 'online', statusText: 'AI developer', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yann' },
                { name: 'Sundar Pichai', role: 'Участники', status: 'idle', statusText: 'Looking around', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Sundar' }
            ];
        }

        let list = [...mockMembersPool[server.name]];

        const currentUserName = document.getElementById('miniName').textContent || currentUserEmail.split('@')[0];
        const currentUserAvatar = document.getElementById('miniAvatar').querySelector('img')?.src || '';
        
        if (!list.some(m => m.name === currentUserName)) {
            list.push({
                name: currentUserName,
                role: 'Участники',
                status: 'online',
                statusText: 'В сети',
                avatar: currentUserAvatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUserEmail}`
            });
        }

        const groups = {};
        list.forEach(m => {
            if (!groups[m.role]) groups[m.role] = [];
            groups[m.role].push(m);
        });

        let html = '';
        const onlineCount = list.filter(m => m.status !== 'offline').length;
        
        html += `
            <div style="font-size: 11px; font-weight: 700; color: #949ba4; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                <span>В сети — ${onlineCount}</span>
            </div>
        `;

        Object.keys(groups).forEach(roleName => {
            const roleMembers = groups[roleName];
            html += `<div class="member-role-title">${roleName} — ${roleMembers.length}</div>`;
            
            roleMembers.forEach(m => {
                const avatarContent = m.avatar ? `<img src="${m.avatar}" class="member-avatar-img">` : '<span class="material-symbols-outlined" style="color: #949ba4; font-size: 20px;">person</span>';
                
                html += `
                    <div class="member-item" title="${m.name} - ${m.statusText || ''}">
                        <div class="member-avatar-wrapper">
                            ${avatarContent}
                            <div class="member-status-dot ${m.status}"></div>
                        </div>
                        <div class="member-info">
                            <div class="member-name">${m.name}</div>
                            <div class="member-custom-status">${m.statusText || ''}</div>
                        </div>
                    </div>
                `;
            });
        });

        sidebar.innerHTML = html;
    }

    window.selectChannel = function(channelId, channelName) {
        currentChannelId = channelId;
        currentRecipient = null;
        
        document.getElementById('chatWelcome').style.display = 'none';
        document.getElementById('activeChat').style.display = 'flex';
        document.getElementById('activeName').textContent = `# ${channelName}`;
        document.getElementById('activeAvatar').innerHTML = `<span class="material-symbols-outlined" style="color: #949ba4;">tag</span>`;
        chatInput.placeholder = `Написать в #${channelName}`;

        const membersSidebar = document.getElementById('membersSidebar');
        if (membersSidebar) {
            membersSidebar.style.display = 'flex';
            const srv = serversList.find(s => s.id === currentServerId);
            if (srv) {
                updateMembersSidebar(srv);
            }
        }

        chatHistory.innerHTML = '<div class="contacts-placeholder">Загрузка сообщений...</div>';
        fetchChannelMessages();

        if (chatPollInterval) clearInterval(chatPollInterval);
        chatPollInterval = setInterval(pollMessages, 2000);
        
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('active');
            if (parseInt(item.getAttribute('data-id')) === channelId) item.classList.add('active');
        });
    };

    function renderServerChannels(channels) {
        const channelsList = document.getElementById('channelsList');
        if (!channels || channels.length === 0) {
            channelsList.innerHTML = '<div class="contacts-placeholder">Нет каналов</div>';
            return;
        }
        
        channelsList.innerHTML = channels.map(ch => `
            <div class="contact-item channel-item" data-id="${ch.id}" onclick="selectChannel(${ch.id}, '${ch.name}')" style="gap: 8px;">
                <span class="material-symbols-outlined" style="font-size: 20px; color: #949ba4;">tag</span>
                <span class="contact-name" style="font-size: 14px;">${ch.name}</span>
            </div>
        `).join('');
    }

    window.selectServer = function(serverId, serverName, channels) {
        currentServerId = serverId;
        currentRecipient = null;
        
        // Hide DMs view elements, show server channels list
        document.querySelector('.sidebar-nav').style.display = 'none';
        document.querySelector('.dm-header').style.display = 'none';
        document.getElementById('contactsList').style.display = 'none';
        
        document.getElementById('serverChannelsContainer').style.display = 'flex';
        document.getElementById('serverSidebarName').textContent = serverName;
        
        document.querySelectorAll('.guild-item').forEach(item => {
            item.classList.remove('active');
            if (parseInt(item.getAttribute('data-id')) === serverId) item.classList.add('active');
        });
        
        renderServerChannels(channels);
        
        if (channels && channels.length > 0) {
            selectChannel(channels[0].id, channels[0].name);
        } else {
            document.getElementById('chatWelcome').style.display = 'flex';
            document.getElementById('activeChat').style.display = 'none';
            currentChannelId = null;
        }
    };

    document.getElementById('dmGuildBtn').addEventListener('click', () => {
        currentServerId = null;
        currentChannelId = null;
        currentRecipient = null;
        
        document.querySelector('.sidebar-nav').style.display = 'flex';
        document.querySelector('.dm-header').style.display = 'flex';
        document.getElementById('contactsList').style.display = 'block';
        document.getElementById('serverChannelsContainer').style.display = 'none';
        
        document.querySelectorAll('.guild-item').forEach(item => {
            item.classList.remove('active');
        });
        document.getElementById('dmGuildBtn').classList.add('active');
        
        document.getElementById('chatWelcome').style.display = 'flex';
        document.getElementById('activeChat').style.display = 'none';
        
        if (chatPollInterval) clearInterval(chatPollInterval);
    });

    async function fetchServers() {
        try {
            const r = await fetch(`${API_URL}/api/servers`);
            const data = await r.json();
            if (r.ok) {
                serversList = data;
                renderServersList(data);
            }
        } catch (e) {
            console.error('Error fetching servers:', e);
        }
    }

    let contextServerId = null;

    function renderServersList(servers) {
        const container = document.getElementById('dynamicGuildsContainer');
        container.innerHTML = servers.map(srv => {
            const isImage = srv.icon && (srv.icon.startsWith('data:') || srv.icon.startsWith('http') || srv.icon.startsWith('/'));
            const innerIcon = isImage 
                ? `<img src="${srv.icon}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">`
                : srv.icon || srv.name.split(' ').map(w => w[0]).join('').substring(0, 3).toUpperCase();

            return `
            <div class="guild-item" data-id="${srv.id}" title="${srv.name}" onclick="handleServerClick(${srv.id})" oncontextmenu="handleServerContextMenu(event, ${srv.id})">
                <div class="guild-icon ${isImage ? '' : 'text-icon'}" style="background-color: #5865f2; color: #fff; font-weight: bold; overflow: hidden; display: flex; align-items: center; justify-content: center;">${innerIcon}</div>
                <div class="guild-indicator"></div>
            </div>
            `;
        }).join('');
    }

    window.handleServerClick = function(serverId) {
        const srv = serversList.find(s => s.id === serverId);
        if (srv) {
            selectServer(srv.id, srv.name, srv.channels);
        }
    };

    window.handleServerContextMenu = function(e, serverId) {
        e.preventDefault();
        e.stopPropagation();
        contextServerId = serverId;
        const menu = document.getElementById('serverContextMenu');
        if (menu) {
            menu.style.display = 'block';
            menu.style.left = `${e.pageX}px`;
            menu.style.top = `${e.pageY}px`;
        }
    };

    // Close context menu when clicking outside
    document.addEventListener('click', () => {
        const menu = document.getElementById('serverContextMenu');
        if (menu) menu.style.display = 'none';
    });

    // Context Menu Action Listeners
    const markReadBtn = document.getElementById('ctxMarkRead');
    if (markReadBtn) {
        markReadBtn.addEventListener('click', () => {
            const srv = serversList.find(s => s.id === contextServerId);
            if (srv) {
                alert(`Сервер "${srv.name}" отмечен как прочитанный`);
            }
        });
    }

    const muteBtn = document.getElementById('ctxMute');
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            alert('Оповещения сервера настроены');
        });
    }

    const inviteBtn = document.getElementById('ctxInvite');
    const inviteServerModal = document.getElementById('inviteServerModal');
    const inviteLinkInput = document.getElementById('inviteLinkInput');
    const copyInviteLinkBtn = document.getElementById('copyInviteLinkBtn');
    const closeInviteModalBtn = document.getElementById('closeInviteModalBtn');

    if (inviteBtn) {
        inviteBtn.addEventListener('click', () => {
            const srv = serversList.find(s => s.id === contextServerId);
            if (srv) {
                document.getElementById('inviteServerName').textContent = `Поделитесь этой ссылкой с друзьями, чтобы они могли присоединиться к ${srv.name}!`;
                inviteLinkInput.value = `${window.location.origin}/invite/${srv.id}`;
                inviteServerModal.style.display = 'flex';
            }
        });
    }

    if (copyInviteLinkBtn) {
        copyInviteLinkBtn.addEventListener('click', () => {
            inviteLinkInput.select();
            document.execCommand('copy');
            const originalText = copyInviteLinkBtn.textContent;
            copyInviteLinkBtn.textContent = 'Скопировано!';
            copyInviteLinkBtn.style.background = '#43b581';
            setTimeout(() => {
                copyInviteLinkBtn.textContent = originalText;
                copyInviteLinkBtn.style.background = '#5865f2';
            }, 2000);
        });
    }

    if (closeInviteModalBtn) {
        closeInviteModalBtn.addEventListener('click', () => {
            inviteServerModal.style.display = 'none';
        });
    }

    if (inviteServerModal) {
        inviteServerModal.addEventListener('click', (e) => {
            if (e.target === inviteServerModal) {
                inviteServerModal.style.display = 'none';
            }
        });
    }

    // Discord style Server Settings Modal
    const settingsBtn = document.getElementById('ctxSettings');
    const discordServerSettingsModal = document.getElementById('discordServerSettingsModal');
    const serverSettingsNameInput = document.getElementById('serverSettingsNameInput');
    const serverSettingsIconInput = document.getElementById('serverSettingsIconInput');
    const serverSettingsSaveBtn = document.getElementById('serverSettingsSaveBtn');
    const closeDiscordServerSettingsBtn = document.getElementById('closeDiscordServerSettingsBtn');
    
    // Server settings tab switching
    const serverSettingsMenuItems = document.querySelectorAll('.server-settings-menu-item');
    const sectionServerProfile = document.getElementById('sectionServerProfile');
    const sectionServerMockSettings = document.getElementById('sectionServerMockSettings');
    const serverSettingsPreviewCard = document.getElementById('serverSettingsPreviewCard');
    const serverMockSectionTitle = document.getElementById('serverMockSectionTitle');

    if (serverSettingsMenuItems) {
        serverSettingsMenuItems.forEach(item => {
            item.addEventListener('click', () => {
                serverSettingsMenuItems.forEach(mi => mi.classList.remove('active'));
                item.classList.add('active');
                
                const section = item.getAttribute('data-section');
                if (section === 'profile') {
                    sectionServerProfile.style.display = 'flex';
                    sectionServerMockSettings.style.display = 'none';
                    serverSettingsPreviewCard.style.display = 'block';
                } else if (section === 'members') {
                    sectionServerProfile.style.display = 'none';
                    sectionServerMockSettings.style.display = 'flex';
                    serverSettingsPreviewCard.style.display = 'none';
                    serverMockSectionTitle.textContent = item.textContent;
                    // Populate Server Members list in settings
                    const srv = serversList.find(s => s.id === contextServerId);
                    if (srv) {
                        renderSettingsMembersList(srv);
                    }
                } else {
                    sectionServerProfile.style.display = 'none';
                    sectionServerMockSettings.style.display = 'flex';
                    serverSettingsPreviewCard.style.display = 'none';
                    serverMockSectionTitle.textContent = item.textContent;
                }
            });
        });
    }

    function renderSettingsMembersList(server) {
        // Base mock data for members
        const mockMembersPool = {
            'Google DeepMind': [
                { name: 'Demis Hassabis', role: 'Основатели', status: 'online', statusText: 'Playing Chess with AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Demis' },
                { name: 'Shane Legg', role: 'Основатели', status: 'dnd', statusText: 'AGI is near', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Shane' },
                { name: 'Sundar Pichai', role: 'Руководство', status: 'online', statusText: 'AI first company', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Sundar' },
                { name: 'Geoffrey Hinton', role: 'Исследователи', status: 'offline', statusText: 'Godfather of AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Geoffrey' },
                { name: 'Yann LeCun', role: 'Исследователи', status: 'online', statusText: 'Autoregressive models suck', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yann' },
                { name: 'Yoshua Bengio', role: 'Исследователи', status: 'idle', statusText: 'AI safety advocate', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yoshua' }
            ],
            'Python Developers': [
                { name: 'Guido van Rossum', role: 'Создатель Python', status: 'online', statusText: 'import antigravity', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Guido' },
                { name: 'Raymond Hettinger', role: 'Core Devs', status: 'dnd', statusText: 'There must be a better way', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Raymond' },
                { name: 'Carol Willing', role: 'Core Devs', status: 'online', statusText: 'Jupyter & Python', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Carol' },
                { name: 'Brett Cannon', role: 'Core Devs', status: 'offline', statusText: 'VS Code Python guy', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Brett' }
            ],
            'Antigravity Workspace': [
                { name: 'Antigravity Bot', role: 'Боты', status: 'online', statusText: 'Here to help you code!', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Antigravity' },
                { name: 'Gemini 1.5 Pro', role: 'ИИ Помощники', status: 'online', statusText: 'Google DeepMind model', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Gemini' },
                { name: 'Claude 3 Opus', role: 'ИИ Помощники', status: 'dnd', statusText: 'Constitutional AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Claude' },
                { name: 'GPT-4o', role: 'ИИ Помощники', status: 'online', statusText: 'Omni model', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=GPT' }
            ]
        };

        let list = [];
        if (mockMembersPool[server.name]) {
            list = [...mockMembersPool[server.name]];
        } else {
            list = [
                { name: server.owner_email.split('@')[0], role: 'Создатель сервера', status: 'online', statusText: 'Владелец сервера', avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${server.owner_email}` },
                { name: 'Yann LeCun', role: 'Участники', status: 'online', statusText: 'AI developer', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Yann' },
                { name: 'Sundar Pichai', role: 'Участники', status: 'idle', statusText: 'Looking around', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Sundar' }
            ];
        }

        const currentUserName = currentUserProfileData?.name || currentUserEmail.split('@')[0];
        const currentUserAvatar = currentUserProfileData?.avatar || '';
        if (!list.some(m => m.name === currentUserName)) {
            list.push({
                name: currentUserName,
                role: 'Участники',
                status: 'online',
                statusText: 'В сети',
                avatar: currentUserAvatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUserEmail}`
            });
        }

        let html = `
            <div style="width: 100%; display: flex; flex-direction: column; gap: 15px; text-align: left; padding: 20px; box-sizing: border-box;">
                <h3 style="font-size: 16px; font-weight: 700; color: #fff; margin: 0 0 10px 0;">Участники сервера (${list.length})</h3>
                <div style="display: flex; flex-direction: column; gap: 10px;">
        `;

        list.forEach(m => {
            const avatarContent = m.avatar ? `<img src="${m.avatar}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">` : '<span class="material-symbols-outlined" style="color: #949ba4; font-size: 20px;">person</span>';
            html += `
                <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 10px 15px; border-radius: 6px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="position: relative; width: 36px; height: 36px; border-radius: 50%; background: #2b2d31; display: flex; align-items: center; justify-content: center;">
                            ${avatarContent}
                            <div class="member-status-dot ${m.status}" style="width: 8px; height: 8px;"></div>
                        </div>
                        <div>
                            <div style="font-size: 14px; font-weight: 600; color: #fff;">${m.name}</div>
                            <div style="font-size: 12px; color: #949ba4;">${m.role} • ${m.statusText || ''}</div>
                        </div>
                    </div>
                    <div>
                        <button class="settings-change-btn" style="background: rgba(255,255,255,0.08); border: none; border-radius: 3px; color: #fff; padding: 6px 12px; font-size: 12px; cursor: pointer;">Действия</button>
                    </div>
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;
        sectionServerMockSettings.innerHTML = html;
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            const srv = serversList.find(s => s.id === contextServerId);
            if (srv) {
                // Reset tab to Profile
                serverSettingsMenuItems.forEach(mi => mi.classList.remove('active'));
                const firstTab = document.querySelector('.server-settings-menu-item[data-section="profile"]');
                if (firstTab) firstTab.classList.add('active');
                
                sectionServerProfile.style.display = 'flex';
                sectionServerMockSettings.style.display = 'none';
                serverSettingsPreviewCard.style.display = 'block';

                document.getElementById('serverSettingsHeaderTitle').textContent = `СЕРВЕР: ${srv.name.toUpperCase()}`;
                serverSettingsNameInput.value = srv.name;
                
                // Update Preview Card — reset session upload and render active icon type
                serverSettingsIconDataUrl = null;
                document.getElementById('serverSettingsPreviewName').textContent = srv.name;
                const previewText = document.getElementById('serverSettingsPreviewIconText');
                let previewImg = document.getElementById('serverSettingsPreviewIconImg');
                const isImage = srv.icon && (srv.icon.startsWith('data:') || srv.icon.startsWith('http') || srv.icon.startsWith('/'));
                
                if (isImage) {
                    if (!previewImg) {
                        previewImg = document.createElement('img');
                        previewImg.id = 'serverSettingsPreviewIconImg';
                        previewImg.className = 'server-icon-img';
                        previewImg.style.width = '100%';
                        previewImg.style.height = '100%';
                        previewImg.style.objectFit = 'cover';
                        previewImg.style.borderRadius = '50%';
                        const container = document.getElementById('serverSettingsPreviewIconContainer');
                        if (container) container.appendChild(previewImg);
                    }
                    previewImg.src = srv.icon;
                    previewImg.style.display = 'block';
                    if (previewText) previewText.style.display = 'none';
                } else {
                    if (previewImg) previewImg.style.display = 'none';
                    if (previewText) {
                        previewText.style.display = 'block';
                        const nameWords = srv.name.trim().split(/\s+/);
                        const abbr = srv.icon || (nameWords.length >= 2
                            ? (nameWords[0][0] + nameWords[1][0]).toUpperCase()
                            : srv.name.substring(0, 2).toUpperCase());
                        previewText.textContent = abbr;
                    }
                }
                
                discordServerSettingsModal.style.display = 'flex';
            }
        });
    }

    if (serverSettingsNameInput) {
        serverSettingsNameInput.addEventListener('input', () => {
            const name = serverSettingsNameInput.value.trim();
            document.getElementById('serverSettingsPreviewName').textContent = name || 'Без имени';
            const previewIconImg = document.getElementById('serverSettingsPreviewIconImg');
            if (!previewIconImg || previewIconImg.style.display === 'none') {
                // Auto-generate abbreviation from name words
                const words = name.trim().split(/\s+/);
                const abbr = words.length >= 2
                    ? (words[0][0] + words[1][0]).toUpperCase()
                    : name.substring(0, 2).toUpperCase();
                document.getElementById('serverSettingsPreviewIconText').textContent = abbr;
            }
        });
    }

    const bannerOptions = document.querySelectorAll('.banner-color-option');
    const previewBanner = document.getElementById('serverSettingsPreviewBanner');
    if (bannerOptions && previewBanner) {
        bannerOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                bannerOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                const color = opt.getAttribute('data-color');
                previewBanner.style.background = color;
            });
        });
    }

    if (closeDiscordServerSettingsBtn) {
        closeDiscordServerSettingsBtn.addEventListener('click', () => {
            discordServerSettingsModal.style.display = 'none';
        });
    }

    // Escape key listener for server settings modal
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (discordServerSettingsModal && discordServerSettingsModal.style.display === 'flex') {
                discordServerSettingsModal.style.display = 'none';
            }
        }
    });

    if (serverSettingsSaveBtn) {
        serverSettingsSaveBtn.addEventListener('click', async () => {
            const name = serverSettingsNameInput.value.trim();
            // Auto-generate icon abbreviation from server name
            const words = name.trim().split(/\s+/);
            const icon = words.length >= 2
                ? (words[0][0] + words[1][0]).toUpperCase()
                : name.substring(0, 2).toUpperCase();
            if (!name) return;
            try {
                const r = await fetch(`${API_URL}/api/servers/${contextServerId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, icon })
                });
                if (r.ok) {
                    discordServerSettingsModal.style.display = 'none';
                    fetchServers();
                }
            } catch (e) {
                console.error('Update server error:', e);
            }
        });
    }

    const leaveBtn = document.getElementById('ctxLeave');
    if (leaveBtn) {
        leaveBtn.addEventListener('click', async () => {
            const srv = serversList.find(s => s.id === contextServerId);
            if (!srv) return;
            const conf = confirm(`Вы уверены, что хотите покинуть сервер "${srv.name}"?`);
            if (!conf) return;
            try {
                const r = await fetch(`${API_URL}/api/servers/${contextServerId}`, {
                    method: 'DELETE'
                });
                if (r.ok) {
                    fetchServers();
                    // Click Direct Messages button to go home
                    const dmBtn = document.getElementById('dmGuildBtn');
                    if (dmBtn) dmBtn.click();
                }
            } catch (e) {
                console.error('Leave server error:', e);
            }
        });
    }

    // Add Server Modal handlers — NEW Discord-style modal
    const createServerModal = document.getElementById('createServerModal');
    const addGuildBtn = document.getElementById('addGuildBtn');
    const closeCreateServerBtn = document.getElementById('closeCreateServerBtn');
    const cancelCreateServerBtn = document.getElementById('cancelCreateServerBtn');
    const submitCreateServerBtn = document.getElementById('submitCreateServerBtn');
    const serverNameInput = document.getElementById('serverNameInput');
    const createServerIconArea = document.getElementById('createServerIconArea');
    const createServerIconFile = document.getElementById('createServerIconFile');
    const createServerIconPreview = document.getElementById('createServerIconPreview');
    const createServerIconLabel = document.getElementById('createServerIconLabel');

    // Uploaded icon data URL for create server
    let createServerIconDataUrl = null;

    function openCreateServerModal() {
        if (createServerModal) {
            createServerModal.classList.add('active');
            if (serverNameInput) serverNameInput.focus();
        }
    }

    function closeCreateServerModal() {
        if (createServerModal) {
            createServerModal.classList.remove('active');
            if (serverNameInput) serverNameInput.value = '';
            createServerIconDataUrl = null;
            if (createServerIconPreview) { createServerIconPreview.style.display = 'none'; createServerIconPreview.src = ''; }
            if (createServerIconLabel) createServerIconLabel.style.display = 'flex';
        }
    }

    if (addGuildBtn) {
        addGuildBtn.addEventListener('click', openCreateServerModal);
    }
    if (closeCreateServerBtn) closeCreateServerBtn.addEventListener('click', closeCreateServerModal);
    if (cancelCreateServerBtn) cancelCreateServerBtn.addEventListener('click', closeCreateServerModal);

    if (createServerModal) {
        createServerModal.addEventListener('click', (e) => {
            if (e.target === createServerModal) closeCreateServerModal();
        });
    }

    // Server icon upload in create modal
    if (createServerIconArea && createServerIconFile) {
        createServerIconArea.addEventListener('click', () => createServerIconFile.click());
        createServerIconFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                createServerIconDataUrl = ev.target.result;
                if (createServerIconPreview) {
                    createServerIconPreview.src = ev.target.result;
                    createServerIconPreview.style.display = 'block';
                }
                if (createServerIconLabel) createServerIconLabel.style.display = 'none';
            };
            reader.readAsDataURL(file);
        });
    }

    if (submitCreateServerBtn) {
        submitCreateServerBtn.addEventListener('click', async () => {
            const name = serverNameInput ? serverNameInput.value.trim() : '';
            if (!name) {
                alert('Пожалуйста, введите название сервера');
                return;
            }
            // Auto-generate abbreviation or use custom uploaded image data url
            const words = name.trim().split(/\s+/);
            const icon = createServerIconDataUrl || (words.length >= 2 
                ? (words[0][0] + words[1][0]).toUpperCase() 
                : name.substring(0, 2).toUpperCase());
            try {
                const r = await fetch(`${API_URL}/api/servers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, owner_email: currentUserEmail, icon: icon })
                });
                if (r.ok) {
                    closeCreateServerModal();
                    fetchServers();
                } else {
                    const data = await r.json();
                    alert('Ошибка: ' + (data.error || 'неизвестно'));
                }
            } catch (e) {
                console.error('Create server error:', e);
            }
        });
    }

    // ─── Server Settings: Auto-abbreviation (no manual input) ─────────────────
    // Override the live preview to use auto-generated abbreviation from name
    const serverSettingsNameInputEl = document.getElementById('serverSettingsNameInput');
    const serverSettingsIconInputEl = document.getElementById('serverSettingsIconInput');

    function getAutoAbbr(name) {
        if (!name) return '';
        const words = name.trim().split(/\s+/);
        if (words.length >= 2) {
            return (words[0][0] + words[1][0]).toUpperCase();
        } else {
            return name.substring(0, 2).toUpperCase();
        }
    }

    if (serverSettingsNameInputEl) {
        serverSettingsNameInputEl.addEventListener('input', () => {
            const name = serverSettingsNameInputEl.value.trim();
            document.getElementById('serverSettingsPreviewName').textContent = name || 'Без имени';
            // Only update abbreviation if no custom icon image
            const previewIconImg = document.getElementById('serverSettingsPreviewIconImg');
            if (!previewIconImg || previewIconImg.style.display === 'none') {
                document.getElementById('serverSettingsPreviewIconText').textContent = getAutoAbbr(name);
            }
        });
    }

    // Server icon upload via clicking the preview circle in settings
    const serverSettingsPreviewIconContainer = document.getElementById('serverSettingsPreviewIconContainer');
    const serverSettingsIconFile = document.getElementById('serverSettingsIconFile');
    let serverSettingsIconDataUrl = null;

    if (serverSettingsPreviewIconContainer && serverSettingsIconFile) {
        serverSettingsPreviewIconContainer.addEventListener('click', () => serverSettingsIconFile.click());
        serverSettingsIconFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                serverSettingsIconDataUrl = ev.target.result;
                // Show image in preview
                const previewText = document.getElementById('serverSettingsPreviewIconText');
                let previewImg = document.getElementById('serverSettingsPreviewIconImg');
                if (!previewImg) {
                    previewImg = document.createElement('img');
                    previewImg.id = 'serverSettingsPreviewIconImg';
                    previewImg.className = 'server-icon-img';
                    serverSettingsPreviewIconContainer.appendChild(previewImg);
                }
                previewImg.src = ev.target.result;
                previewImg.style.display = 'block';
                if (previewText) previewText.style.display = 'none';
            };
            reader.readAsDataURL(file);
        });
    }

    // Also patch serverSettingsSaveBtn to use auto-abbr if icon field is empty
    const serverSettingsSaveBtnEl = document.getElementById('serverSettingsSaveBtn');
    if (serverSettingsSaveBtnEl) {
        // Remove old listener by cloning
        const newSaveBtn = serverSettingsSaveBtnEl.cloneNode(true);
        serverSettingsSaveBtnEl.parentNode.replaceChild(newSaveBtn, serverSettingsSaveBtnEl);
        newSaveBtn.addEventListener('click', async () => {
            const name = serverSettingsNameInputEl ? serverSettingsNameInputEl.value.trim() : '';
            const srv = serversList.find(s => s.id === contextServerId);
            const icon = serverSettingsIconDataUrl || (srv ? srv.icon : getAutoAbbr(name));
            if (!name) return;
            try {
                const r = await fetch(`${API_URL}/api/servers/${contextServerId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, icon })
                });
                if (r.ok) {
                    discordServerSettingsModal.style.display = 'none';
                    serverSettingsIconDataUrl = null;
                    fetchServers();
                }
            } catch (e) {
                console.error('Update server error:', e);
            }
        });
    }

    // ─── Server sidebar name click → opens server settings dropdown ───────────
    const serverSidebarNameBtn = document.getElementById('serverSidebarNameBtn');
    if (serverSidebarNameBtn) {
        serverSidebarNameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentServerId) {
                contextServerId = currentServerId;
                const menu = document.getElementById('serverContextMenu');
                if (menu) {
                    // Update live stats in the setting preview if they open settings later
                    const srv = serversList.find(s => s.id === currentServerId);
                    if (srv) {
                        updateSettingsLiveStats(srv);
                    }
                    menu.style.display = 'block';
                    const rect = serverSidebarNameBtn.getBoundingClientRect();
                    menu.style.left = `${rect.left}px`;
                    menu.style.top = `${rect.bottom + window.scrollY}px`;
                }
            }
        });
    }

    // ─── Resizable Panels ─────────────────────────────────────────────────────
    function initResizeHandle(handleId, leftSideId, minLeft, maxLeft) {
        const handle = document.getElementById(handleId);
        const leftSide = document.getElementById(leftSideId);
        if (!handle || !leftSide) return;

        let isDragging = false;
        let startX = 0;
        let startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startWidth = leftSide.getBoundingClientRect().width;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const newWidth = Math.min(maxLeft, Math.max(minLeft, startWidth + dx));
            leftSide.style.width = newWidth + 'px';
            leftSide.style.flexShrink = '0';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    }

    // Resize between guilds sidebar and app sidebar
    initResizeHandle('appSidebarHandle', 'appSidebar', 160, 380);
    // Resize members sidebar
    initResizeHandle('membersSidebarHandle', 'membersSidebar', 140, 400);

    // ─── Message Right-Click Context Menu ─────────────────────────────────────
    const messageContextMenu = document.getElementById('messageContextMenu');
    let ctxMsgData = null; // { id, text, senderEmail, msgEl }

    function hideMessageCtxMenu() {
        if (messageContextMenu) messageContextMenu.style.display = 'none';
        ctxMsgData = null;
    }

    // Delegate right-click to chatHistory
    chatHistory.addEventListener('contextmenu', (e) => {
        const msgEl = e.target.closest('.discord-message');
        if (!msgEl) return;
        e.preventDefault();

        const msgId = msgEl.getAttribute('data-msg-id');
        const msgText = msgEl.querySelector('.discord-message-text')?.textContent || '';
        const msgSender = msgEl.getAttribute('data-sender');
        const isMine = (msgSender === currentUserEmail);

        ctxMsgData = { id: msgId, text: msgText, senderEmail: msgSender, msgEl, isMine };

        // Show/hide edit & delete for own messages only
        const editItem = document.getElementById('msgCtxEdit');
        const deleteItem = document.getElementById('msgCtxDelete');
        if (editItem) editItem.style.display = isMine ? 'flex' : 'none';
        if (deleteItem) deleteItem.style.display = isMine ? 'flex' : 'none';

        // Position menu
        let x = e.clientX, y = e.clientY;
        messageContextMenu.style.display = 'block';
        const menuW = messageContextMenu.offsetWidth;
        const menuH = messageContextMenu.offsetHeight;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
        messageContextMenu.style.left = x + 'px';
        messageContextMenu.style.top = y + 'px';
    });

    document.addEventListener('click', () => hideMessageCtxMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMessageCtxMenu(); });

    // Edit message
    const msgCtxEdit = document.getElementById('msgCtxEdit');
    if (msgCtxEdit) {
        msgCtxEdit.addEventListener('click', () => {
            if (!ctxMsgData || !ctxMsgData.isMine) return;
            const { id, text, msgEl } = ctxMsgData;
            hideMessageCtxMenu();

            // Enable edit mode
            msgEl.classList.add('editing');
            msgEl.setAttribute('data-editing', 'true');

            // Build edit area if not already present
            let editArea = msgEl.querySelector('.message-edit-area');
            if (!editArea) {
                editArea = document.createElement('div');
                editArea.className = 'message-edit-area';
                editArea.innerHTML = `
                    <textarea class="message-edit-input" rows="2">${text}</textarea>
                    <div class="message-edit-actions">
                        <span>Esc \u2014 </span><span class="edit-cancel">отмена</span>
                        &nbsp;&bull;&nbsp;
                        <span class="edit-save">Сохранить</span>
                    </div>`;
                const contentDiv = msgEl.querySelector('.discord-message-content');
                if (contentDiv) contentDiv.appendChild(editArea);
            }
            const textarea = editArea.querySelector('.message-edit-input');
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);

            // Cancel
            editArea.querySelector('.edit-cancel').onclick = () => {
                msgEl.classList.remove('editing');
                editArea.remove();
            };

            // Save
            editArea.querySelector('.edit-save').onclick = async () => {
                const newText = textarea.value.trim();
                if (!newText) return;
                try {
                    const endpoint = currentChannelId
                        ? `${API_URL}/api/channels/${currentChannelId}/messages/${id}`
                        : `${API_URL}/api/messages/${id}`;
                    const r = await fetch(endpoint, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: newText, sender_email: currentUserEmail })
                    });
                    if (r.ok) {
                        const textEl = msgEl.querySelector('.discord-message-text');
                        if (textEl) textEl.textContent = newText;
                    }
                } catch(e) { console.error('Edit message error:', e); }
                msgEl.classList.remove('editing');
                editArea.remove();
            };

            // ESC to cancel
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { msgEl.classList.remove('editing'); editArea.remove(); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editArea.querySelector('.edit-save').click(); }
            });
        });
    }

    // Reply to message
    const msgCtxReply = document.getElementById('msgCtxReply');
    const replyBar = document.getElementById('replyBar');
    const replyBarName = document.getElementById('replyBarName');
    const replyBarClose = document.getElementById('replyBarClose');
    let replyToData = null; // { id, text, senderName }

    if (msgCtxReply) {
        msgCtxReply.addEventListener('click', () => {
            if (!ctxMsgData) return;
            const { id, text, msgEl } = ctxMsgData;
            const senderName = msgEl.querySelector('.discord-message-author')?.textContent || 'пользователь';
            replyToData = { id, text, senderName };
            hideMessageCtxMenu();
            if (replyBarName) replyBarName.textContent = senderName;
            if (replyBar) replyBar.classList.add('active');
            chatInput.focus();
        });
    }

    if (replyBarClose) {
        replyBarClose.addEventListener('click', () => {
            replyToData = null;
            if (replyBar) replyBar.classList.remove('active');
        });
    }

    // Copy text
    const msgCtxCopy = document.getElementById('msgCtxCopy');
    if (msgCtxCopy) {
        msgCtxCopy.addEventListener('click', () => {
            if (!ctxMsgData) return;
            navigator.clipboard.writeText(ctxMsgData.text).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = ctxMsgData.text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            });
            hideMessageCtxMenu();
        });
    }

    // Delete message
    const msgCtxDelete = document.getElementById('msgCtxDelete');
    if (msgCtxDelete) {
        msgCtxDelete.addEventListener('click', async () => {
            if (!ctxMsgData || !ctxMsgData.isMine) return;
            const { id, msgEl } = ctxMsgData;
            hideMessageCtxMenu();
            try {
                const endpoint = currentChannelId
                    ? `${API_URL}/api/channels/${currentChannelId}/messages/${id}`
                    : `${API_URL}/api/messages/${id}`;
                const r = await fetch(endpoint, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sender_email: currentUserEmail })
                });
                if (r.ok) {
                    msgEl.style.transition = 'opacity 0.3s';
                    msgEl.style.opacity = '0';
                    setTimeout(() => msgEl.remove(), 300);
                }
            } catch(e) { console.error('Delete message error:', e); }
        });
    }

    // ─── Channel Right-Click Context Menu ─────────────────────────────────────
    const channelContextMenu = document.getElementById('channelContextMenu');
    const chCtxMute = document.getElementById('chCtxMute');
    let ctxChannelId = null;
    const mutedChannels = new Set();

    function hideChannelCtxMenu() {
        if (channelContextMenu) channelContextMenu.style.display = 'none';
        ctxChannelId = null;
    }

    // Delegate to channelsList
    const channelsListEl = document.getElementById('channelsList');
    if (channelsListEl) {
        channelsListEl.addEventListener('contextmenu', (e) => {
            const chItem = e.target.closest('.channel-item');
            if (!chItem) return;
            e.preventDefault();
            ctxChannelId = parseInt(chItem.getAttribute('data-id'));

            // Update mute label
            if (chCtxMute) {
                const isMuted = mutedChannels.has(ctxChannelId);
                chCtxMute.innerHTML = isMuted
                    ? '<span class="material-symbols-outlined">volume_up</span> Включить звук канала'
                    : '<span class="material-symbols-outlined">volume_off</span> Заглушить канал';
                chCtxMute.className = isMuted ? 'ch-ctx-item muted' : 'ch-ctx-item';
            }

            let x = e.clientX, y = e.clientY;
            channelContextMenu.style.display = 'block';
            const mw = channelContextMenu.offsetWidth, mh = channelContextMenu.offsetHeight;
            if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
            if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
            channelContextMenu.style.left = x + 'px';
            channelContextMenu.style.top = y + 'px';
        });
    }

    document.addEventListener('click', () => hideChannelCtxMenu());

    if (chCtxMute) {
        chCtxMute.addEventListener('click', () => {
            if (ctxChannelId === null) return;
            if (mutedChannels.has(ctxChannelId)) {
                mutedChannels.delete(ctxChannelId);
            } else {
                mutedChannels.add(ctxChannelId);
            }
            // Update visual
            const chItem = channelsListEl ? channelsListEl.querySelector(`.channel-item[data-id="${ctxChannelId}"]`) : null;
            if (chItem) {
                chItem.classList.toggle('muted', mutedChannels.has(ctxChannelId));
            }
            hideChannelCtxMenu();
        });
    }

    // ─── Patch renderMessages to include msg IDs and sender data attrs ─────────
    // Override the global renderMessages used by channels to add data attributes needed for context menu
    const _origRenderMessages = window._renderMessages;


    let currentUserProfileData = {};

    function populateSettingsUI() {
        if (!currentUserProfileData) return;
        
        const name = currentUserProfileData.name || '';
        document.getElementById('settingsMiniName').textContent = name;
        document.getElementById('settingsProfileNick').textContent = name;
        document.getElementById('settingsValDisplayName').textContent = name;
        
        const avatar = currentUserProfileData.avatar;
        const avatarHtml = avatar ? `<img src="${avatar}" style="width: 100%; height: 100%; object-fit: cover;">` : '<span class="material-symbols-outlined" style="font-size: 28px; color: #fff;">account_circle</span>';
        document.getElementById('settingsMiniAvatar').innerHTML = avatarHtml;
        
        const cardAvatarHtml = avatar ? `<img src="${avatar}" style="width: 100%; height: 100%; object-fit: cover;">` : '<span class="material-symbols-outlined" style="font-size: 60px; color: #fff;">account_circle</span>';
        document.getElementById('settingsAvatarContainer').innerHTML = cardAvatarHtml;

        const username = currentUserProfileData.username || (currentUserProfileData.email ? currentUserProfileData.email.split('@')[0] : 'user');
        document.getElementById('settingsValUsername').textContent = username;

        const email = currentUserProfileData.email || '';
        const maskedEmail = email ? maskEmail(email) : '';
        const emailEl = document.getElementById('settingsValEmail');
        emailEl.textContent = maskedEmail;
        emailEl.dataset.actual = email;
        emailEl.dataset.masked = maskedEmail;
        document.getElementById('toggleSettingsEmailBtn').textContent = 'Показать';

        const phone = currentUserProfileData.phone || '';
        const maskedPhone = phone ? maskPhone(phone) : 'Не указан';
        const phoneEl = document.getElementById('settingsValPhone');
        phoneEl.textContent = maskedPhone;
        phoneEl.dataset.actual = phone || 'Не указан';
        phoneEl.dataset.masked = maskedPhone;
        document.getElementById('toggleSettingsPhoneBtn').textContent = phone ? 'Показать' : '';
        document.getElementById('deleteSettingsPhoneBtn').style.display = phone ? 'inline-block' : 'none';
    }

    function maskEmail(email) {
        const parts = email.split('@');
        if (parts.length < 2) return email;
        const name = parts[0];
        const domain = parts[1];
        if (name.length <= 2) return '*'.repeat(name.length) + '@' + domain;
        return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1] + '@' + domain;
    }

    function maskPhone(phone) {
        if (phone.length <= 4) return '*'.repeat(phone.length);
        return '*'.repeat(phone.length - 4) + phone.slice(-4);
    }

    document.getElementById('toggleSettingsEmailBtn').addEventListener('click', (e) => {
        const emailEl = document.getElementById('settingsValEmail');
        if (e.target.textContent === 'Показать') {
            emailEl.textContent = emailEl.dataset.actual;
            e.target.textContent = 'Скрыть';
        } else {
            emailEl.textContent = emailEl.dataset.masked;
            e.target.textContent = 'Показать';
        }
    });

    document.getElementById('toggleSettingsPhoneBtn').addEventListener('click', (e) => {
        const phoneEl = document.getElementById('settingsValPhone');
        if (!phoneEl.dataset.actual || phoneEl.dataset.actual === 'Не указан') return;
        if (e.target.textContent === 'Показать') {
            phoneEl.textContent = phoneEl.dataset.actual;
            e.target.textContent = 'Скрыть';
        } else {
            phoneEl.textContent = phoneEl.dataset.masked;
            e.target.textContent = 'Показать';
        }
    });

    document.getElementById('deleteSettingsPhoneBtn').addEventListener('click', async () => {
        if (!confirm('Вы действительно хотите удалить номер телефона?')) return;
        try {
            const r = await fetch(`${API_URL}/update_profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: currentUserEmail, phone: '' })
            });
            if (r.ok) {
                currentUserProfileData.phone = '';
                populateSettingsUI();
                showMessage('Номер телефона удален', 'success');
            }
        } catch(e) {
            console.error('Delete phone error:', e);
        }
    });

    document.getElementById('openSettings').addEventListener('click', () => {
        setQuality(false);
        populateSettingsUI();
        document.getElementById('discordSettingsModal').style.display = 'flex';
    });

    function closeDiscordSettings() {
        document.getElementById('discordSettingsModal').style.display = 'none';
        setQuality(true);
    }
    document.getElementById('closeDiscordSettingsBtn').addEventListener('click', closeDiscordSettings);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (document.getElementById('settingsEditModal').style.display === 'flex') {
                document.getElementById('settingsEditModal').style.display = 'none';
            } else if (document.getElementById('discordSettingsModal').style.display === 'flex') {
                closeDiscordSettings();
            }
        }
    });

    document.getElementById('settingsEditUserCardBtn').addEventListener('click', () => profAvatarFile.click());
    document.getElementById('settingsAvatarContainer').addEventListener('click', () => profAvatarFile.click());
    document.getElementById('settingsEditProfileTrigger').addEventListener('click', () => profAvatarFile.click());

    document.querySelectorAll('.settings-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            document.querySelectorAll('.settings-menu-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            
            const section = item.dataset.section;
            if (section === 'my_account') {
                document.getElementById('sectionMyAccount').style.display = 'block';
                document.getElementById('sectionMockSettings').style.display = 'none';
            } else {
                document.getElementById('sectionMyAccount').style.display = 'none';
                document.getElementById('sectionMockSettings').style.display = 'flex';
                document.getElementById('mockSectionTitle').textContent = item.textContent;
            }
        });
    });

    let currentEditField = null;
    const settingsEditModal = document.getElementById('settingsEditModal');
    const settingsEditModalTitle = document.getElementById('settingsEditModalTitle');
    const settingsEditModalLabel = document.getElementById('settingsEditModalLabel');
    const settingsEditModalInput = document.getElementById('settingsEditModalInput');

    function openSettingsEditModal(field) {
        currentEditField = field;
        settingsEditModalInput.value = '';
        settingsEditModalInput.type = 'text';

        if (field === 'display_name') {
            settingsEditModalTitle.textContent = 'Изменить отображаемое имя';
            settingsEditModalLabel.textContent = 'Новое отображаемое имя';
            settingsEditModalInput.value = currentUserProfileData.name || '';
        } else if (field === 'username') {
            settingsEditModalTitle.textContent = 'Изменить имя пользователя';
            settingsEditModalLabel.textContent = 'Новое имя пользователя';
            settingsEditModalInput.value = currentUserProfileData.username || (currentUserProfileData.email ? currentUserProfileData.email.split('@')[0] : 'user');
        } else if (field === 'email') {
            settingsEditModalTitle.textContent = 'Изменить адрес электронной почты';
            settingsEditModalLabel.textContent = 'Новый адрес электронной почты';
            settingsEditModalInput.value = currentUserProfileData.email || '';
        } else if (field === 'phone') {
            settingsEditModalTitle.textContent = 'Изменить номер телефона';
            settingsEditModalLabel.textContent = 'Новый номер телефона';
            settingsEditModalInput.value = currentUserProfileData.phone || '';
        } else if (field === 'password') {
            settingsEditModalTitle.textContent = 'Сменить пароль';
            settingsEditModalLabel.textContent = 'Новый пароль';
            settingsEditModalInput.type = 'password';
        }

        settingsEditModal.style.display = 'flex';
        settingsEditModalInput.focus();
    }

    document.querySelectorAll('.settings-change-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const field = e.currentTarget.dataset.field;
            openSettingsEditModal(field);
        });
    });

    document.getElementById('settingsChangePassBtn').addEventListener('click', () => {
        openSettingsEditModal('password');
    });

    document.getElementById('submitSettingsEditModalBtn').addEventListener('click', async () => {
        const val = settingsEditModalInput.value.trim();
        if (currentEditField !== 'password' && !val && currentEditField !== 'phone') {
            alert('Поле не может быть пустым');
            return;
        }

        const payload = { email: currentUserEmail };
        
        if (currentEditField === 'display_name') {
            payload.name = val;
        } else if (currentEditField === 'username') {
            payload.username = val;
        } else if (currentEditField === 'email') {
            if (!val.includes('@')) {
                alert('Некорректный email');
                return;
            }
            payload.new_email = val;
        } else if (currentEditField === 'phone') {
            payload.phone = val;
        } else if (currentEditField === 'password') {
            if (val.length < 6) {
                alert('Пароль должен быть не менее 6 символов');
                return;
            }
            payload.password = val;
        }

        try {
            const r = await fetch(`${API_URL}/update_profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await r.json();
            if (r.ok) {
                if (currentEditField === 'display_name') {
                    currentUserProfileData.name = val;
                    document.getElementById('miniName').textContent = val;
                } else if (currentEditField === 'username') {
                    currentUserProfileData.username = val;
                } else if (currentEditField === 'email') {
                    currentUserProfileData.email = val;
                    currentUserEmail = val;
                } else if (currentEditField === 'phone') {
                    currentUserProfileData.phone = val;
                }
                
                populateSettingsUI();
                settingsEditModal.style.display = 'none';
                showMessage('Настройки успешно изменены!', 'success');
            } else {
                alert('Ошибка: ' + (data.error || 'не удалось сохранить'));
            }
        } catch (e) {
            console.error('Update setting error:', e);
            alert('Ошибка сети при сохранении настроек');
        }
    });

    document.getElementById('closeSettingsEditModalBtn').addEventListener('click', () => {
        settingsEditModal.style.display = 'none';
    });

    // --- Auth Forms Logic ---
    document.getElementById('registrationForm').addEventListener('submit', async e => {
        e.preventDefault();
        const name=document.getElementById('regName').value.trim();
        const email=document.getElementById('regEmail').value.trim();
        const password=document.getElementById('regPassword').value;
        const passwordConfirm=document.getElementById('regPasswordConfirm').value;
        const phone=document.getElementById('regPhone').value;
        const avatarFile=document.getElementById('regAvatarFile').files[0];
        
        if (!name) {
            showMessage('Пожалуйста, введите имя', 'error');
            return;
        }
        if (!email) {
            showMessage('Пожалуйста, введите email или ID', 'error');
            return;
        }
        if (!email.includes('@')) {
            showMessage('Адрес электронной почты должен содержать символ "@". В адресе "' + email + '" отсутствует символ "@".', 'error');
            return;
        }
        if (!password) {
            showMessage('Пожалуйста, введите пароль', 'error');
            return;
        }
        if (password.length < 6) {
            showMessage('Пароль должен быть не менее 6 символов', 'error');
            return;
        }
        if (password !== passwordConfirm) {
            showMessage('Пароли не совпадают', 'error');
            return;
        }

        const recaptchaResponse = grecaptcha.getResponse();
        if (!recaptchaResponse) {
            showMessage('Пожалуйста, подтвердите капчу', 'error');
            return;
        }

        showMessage('Регистрация…', 'info');
        try {
            const r = await fetch(`${API_URL}/register`, {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({
                    name,
                    email,
                    password,
                    g_recaptcha_response: recaptchaResponse
                })
            });
            const d = await r.json();
            if (r.ok) {
                let finalAvatarUrl = '';
                if (avatarFile) {
                    const formData = new FormData();
                    formData.append('avatar', avatarFile, 'avatar.jpg');
                    try {
                        const rAvatar = await fetch(`${API_URL}/upload_avatar`, { method: 'POST', body: formData });
                        const dAvatar = await rAvatar.json();
                        if (rAvatar.ok) finalAvatarUrl = dAvatar.avatar_url;
                    } catch(e) { console.error('Avatar upload failed', e); }
                }
                
                if (phone || finalAvatarUrl) {
                    await fetch(`${API_URL}/update_profile`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({email, avatar: finalAvatarUrl, phone, bio: ''})
                    });
                }

                showMessage('Успех!','success'); 
                document.getElementById('registrationForm').reset(); 
                if (window.grecaptcha) grecaptcha.reset();
                localStorage.setItem('has_visited', 'true');
                setTimeout(()=>loadProfileUI({name:d.name,email:d.email,avatar:finalAvatarUrl,bio:'',phone}),1000); 
            }
            else { 
                showMessage(d.error||'Ошибка','error'); 
                if (window.grecaptcha) grecaptcha.reset(); 
            }
        } catch (err) { 
            showMessage('Ошибка сервера','error'); 
            if (window.grecaptcha) grecaptcha.reset(); 
        }
    });

    document.getElementById('loginForm').addEventListener('submit', async e => {
        e.preventDefault();
        const email=document.getElementById('loginEmail').value.trim(), password=document.getElementById('loginPassword').value;
        if (!email) {
            showMessage('Пожалуйста, введите email или ID', 'error');
            return;
        }
        if (!email.includes('@')) {
            showMessage('Адрес электронной почты должен содержать символ "@". В адресе "' + email + '" отсутствует символ "@".', 'error');
            return;
        }
        if (!password) {
            showMessage('Пожалуйста, введите пароль', 'error');
            return;
        }
        showMessage('Вход…','info');
        try {
            const r = await fetch(`${API_URL}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
            const d = await r.json();
            if (r.ok) { 
                showMessage(`Привет, ${d.name}!`,'success'); 
                localStorage.setItem('has_visited', 'true');
                setTimeout(()=>loadProfileUI(d),500); 
            }
            else showMessage(d.error||'Ошибка входа','error');
        } catch (err) { showMessage('Ошибка сервера','error'); }
    });

    let resetEmail = '';

    document.getElementById('forgotPasswordForm').addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('forgotEmail').value.trim();
        if (!email) {
            showMessage('Пожалуйста, введите email или ID', 'error');
            return;
        }
        if (!email.includes('@')) {
            showMessage('Адрес электронной почты должен содержать символ "@". В адресе "' + email + '" отсутствует символ "@".', 'error');
            return;
        }
        showMessage('Отправка кода…', 'info');
        try {
            const r = await fetch(`${API_URL}/forgot_password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const d = await r.json();
            if (r.ok) {
                resetEmail = email;
                showMessage('Код отправлен на почту', 'success');
                setTimeout(() => showSection(resetSection, 'Новый пароль | Premium Project'), 1000);
            } else {
                showMessage(d.error || 'Ошибка', 'error');
            }
        } catch (err) { showMessage('Ошибка сервера', 'error'); }
    });

    document.getElementById('resetPasswordForm').addEventListener('submit', async e => {
        e.preventDefault();
        const code = document.getElementById('resetCode').value;
        const new_password = document.getElementById('resetNewPassword').value;
        showMessage('Смена пароля…', 'info');
        try {
            const r = await fetch(`${API_URL}/reset_password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: resetEmail, code, new_password })
            });
            const d = await r.json();
            if (r.ok) {
                showMessage('Пароль успешно изменен', 'success');
                setTimeout(() => showSection(loginSection, 'Вход | Premium Project'), 1000);
            } else {
                showMessage(d.error || 'Ошибка', 'error');
            }
        } catch (err) { showMessage('Ошибка сервера', 'error'); }
    });

    document.getElementById('profileForm').addEventListener('submit', async e => {
        e.preventDefault();
        const avatar=document.getElementById('profAvatar').value;
        const phone=document.getElementById('profPhone').value;
        const bio=document.getElementById('profBio').value;
        const name=document.getElementById('profName').value;
        const birthdate=document.getElementById('profBirthdate').value;
        const password=document.getElementById('profNewPassword').value;

        showMessage('Сохранение…','info');
        try {
            const r = await fetch(`${API_URL}/update_profile`,{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({email:currentUserEmail, avatar, phone, bio, name, birthdate, password})
            });
            if (r.ok) {
                showMessage('Сохранено!','success');
                // Update UI without reload
                document.getElementById('profileWelcome').textContent = `Привет, ${name}!`;
                document.getElementById('miniName').textContent = name;
                if (avatar) {
                    document.getElementById('miniAvatar').innerHTML = `<img src="${avatar}">`;
                }
                fetchActiveContacts(); // to update self in any relevant lists if needed
            } else {
                showMessage('Ошибка сохранения','error');
            }
        } catch (err) { showMessage('Ошибка сервера','error'); }
    });

    function resetChatState() {
        document.getElementById('activeChat').style.display = 'none';
        document.getElementById('chatWelcome').style.display = 'flex';
        document.getElementById('chatInput').value = '';
        document.getElementById('chatHistory').innerHTML = '';
        currentRecipient = null;
        if (chatPollInterval) {
            clearInterval(chatPollInterval);
            chatPollInterval = null;
        }
    }

    document.getElementById('btnLogout').addEventListener('click', () => {
        currentUserEmail = null;
        setQuality(false); // Reset quality
        document.getElementById('appInterface').classList.remove('active');
        profileSection.classList.remove('active');
        resetChatState();
        showSection(loginSection, 'Вход | Premium Project');
        showMessage('Вы вышли', 'info');
    });

    document.getElementById('miniLogout').addEventListener('click', () => {
        currentUserEmail = null;
        setQuality(false);
        document.getElementById('appInterface').classList.remove('active');
        
        const containerUI = document.querySelector('.container');
        if (containerUI) {
            containerUI.style.opacity = '1';
            containerUI.style.visibility = 'visible';
            containerUI.style.pointerEvents = 'auto';
        }
        
        resetChatState();
        showSection(loginSection, 'Вход | Premium Project');
        showMessage('Вы вышли из аккаунта', 'info');
    });


    window.openSocialAuth = function(provider) {
        const url=`${API_URL}/auth/${provider}/login`,w=500,h=600;
        window.open(url,'OAuth',`width=${w},height=${h},top=${(window.innerHeight-h)/2},left=${(window.innerWidth-w)/2}`);
    };

    window.addEventListener('message', event => {
        if (event.origin!==window.location.origin && event.origin!==API_URL) return;
        if (event.data && event.data.type==='OAUTH_SUCCESS') loadProfileUI(event.data.user);
    });

    const storedUser = localStorage.getItem('oauth_user');
    if (storedUser) {
        const d = JSON.parse(storedUser);
        localStorage.removeItem('oauth_user');
        loadProfileUI(d);
    }

    // Helper to read cookies
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
    }

    // Device / IP State memory check to show login by default for returning visitors
    const isVisited = localStorage.getItem('has_visited') === 'true' || getCookie('ip_visited') === 'true';
    if (isVisited) {
        showSection(loginSection, 'Вход | Premium Project');
    } else {
        showSection(registerSection, 'Регистрация | Premium Project');
        localStorage.setItem('has_visited', 'true');
    }
});

function showMessage(text, type) {
    const s = document.getElementById('statusMessage');
    s.textContent = text;
    s.className = 'status-message show';
    if      (type === 'error')   s.classList.add('status-error');
    else if (type === 'success') s.classList.add('status-success');
    else {
        s.classList.add('status-success');
        s.style.background   = 'rgba(59,130,246,.1)';
        s.style.color        = '#93c5fd';
        s.style.borderColor  = 'rgba(59,130,246,.2)';
    }
}
function clearMessages() {
    const s = document.getElementById('statusMessage');
    s.className = 'status-message';
    s.textContent = '';
}
