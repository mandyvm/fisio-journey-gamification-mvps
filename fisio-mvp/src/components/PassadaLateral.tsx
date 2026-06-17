import React, { useRef, useState, useEffect } from 'react';
import { Unity, useUnityContext } from 'react-unity-webgl';
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';

export default function PassadaLateral() {
  // ========================================================
  // 1. CONFIGURAÇÕES CLÍNICAS E ESTADOS
  // ========================================================
  const [configClinica, setConfigClinica] = useState({ 
    metaAbertura: 35,     
    limiteAbertura: 48,   
    repsEsquerda: 2,
    repsDireita: 2,
    seriesTotais: 2,
    descansoRep: 3,
    descansoSerie: 10
  });
  
  const [exercicioIniciado, setExercicioIniciado] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const [alertaPostura, setAlertaPostura] = useState(false);

  const [serieAtual, setSerieAtual] = useState(1);
  const [repsFeitasEsq, setRepsFeitasEsq] = useState(0); 
  const [repsFeitasDir, setRepsFeitasDir] = useState(0); 
  const [estadoMovimento, setEstadoMovimento] = useState("REPOUSO");
  const [distanciaAtual, setDistanciaAtual] = useState(0); 
  
  const [tempoDescansoVisual, setTempoDescansoVisual] = useState(0);
  const [progressoInicio, setProgressoInicio] = useState(0); 
  const [progressoEsq, setProgressoEsq] = useState(0);
  const [progressoDir, setProgressoDir] = useState(0);
  const [relatorioFinal, setRelatorioFinal] = useState<any[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const requestRef = useRef<number>(0);
  const tempoUltimoFrameRef = useRef<number>(-1);
  
  const refEstadoMovimento = useRef("REPOUSO");
  const refTempoRestante = useRef(0);
  const refDistancia = useRef(0);
  const refEmDescanso = useRef(false);
  const refAlertaPostura = useRef(false);
  const menuAbertoRef = useRef(menuAberto);

  const contadorGestoEsqRef = useRef(0); 
  const contadorGestoDirRef = useRef(0); 

  const configRef = useRef(configClinica);
  const iniciadoRef = useRef(exercicioIniciado);
  
  const spotAtualEsq = useRef("CENTRO");
  const spotAtualDir = useRef("CENTRO");

  useEffect(() => { configRef.current = configClinica; }, [configClinica]);
  useEffect(() => { iniciadoRef.current = exercicioIniciado; }, [exercicioIniciado]);
  useEffect(() => { menuAbertoRef.current = menuAberto; }, [menuAberto]);

  const cicloRef = useRef({ estagio: "REPOUSO", lado: "" });

  const contagemRef = useRef({
    repsEsq: 0, repsDir: 0, serie: 1, fimDescansoMs: 0, tipoDescanso: "",
    repAtualExcedeu: false, repAtualCompensou: false,
    historico: [ { serie: 1, corretas: 0, incorretas: 0, compensacoes: 0 } ]
  });

  // ========================================================
  // 2. FUNÇÃO CENTRAL DE PONTUAÇÃO
  // ========================================================
  const contabilizarRepeticao = () => {
    const histAtual = contagemRef.current.historico[contagemRef.current.serie - 1];
    
    // Contabiliza Acertos vs Distância Excedida
    if (contagemRef.current.repAtualExcedeu) histAtual.incorretas++; else histAtual.corretas++;
    
    // Contabiliza ERRO DE POSTURA (Se a flag foi ativada durante a repetição)
    if (contagemRef.current.repAtualCompensou) histAtual.compensacoes++;

    // Zera as flags para a próxima repetição
    contagemRef.current.repAtualExcedeu = false; 
    contagemRef.current.repAtualCompensou = false;

    // Atualiza placar
    if (cicloRef.current.lado === "DIREITA") {
        contagemRef.current.repsDir++; setRepsFeitasDir(contagemRef.current.repsDir);
    } else {
        contagemRef.current.repsEsq++; setRepsFeitasEsq(contagemRef.current.repsEsq);
    }

    const totalFeitas = contagemRef.current.repsEsq + contagemRef.current.repsDir;
    const totalMeta = configRef.current.repsEsquerda + configRef.current.repsDireita;

    // Verifica se terminou a série
    if (totalFeitas >= totalMeta) {
        if (contagemRef.current.serie < configRef.current.seriesTotais) {
            cicloRef.current.estagio = "DESCANSO"; contagemRef.current.tipoDescanso = "SERIE";
            contagemRef.current.fimDescansoMs = performance.now() + (configRef.current.descansoSerie * 1000);
        } else {
            cicloRef.current.estagio = "FINALIZADO"; refEstadoMovimento.current = "TREINO CONCLUÍDO!";
            setEstadoMovimento("TREINO CONCLUÍDO!"); setRelatorioFinal([...contagemRef.current.historico]); 
        }
    } else {
        cicloRef.current.estagio = "DESCANSO"; contagemRef.current.tipoDescanso = "REP";
        contagemRef.current.fimDescansoMs = performance.now() + (configRef.current.descansoRep * 1000);
    }
  };

  // ========================================================
  // 3. BUILD DA UNITY E OUVINTE DO TAPETE
  // ========================================================
  const { unityProvider, sendMessage, isLoaded, addEventListener, removeEventListener } = useUnityContext({
    loaderUrl: "/unity/PassadaLateral/Build/passadaLateral.loader.js", 
    dataUrl: "/unity/PassadaLateral/Build/passadaLateral.data",
    frameworkUrl: "/unity/PassadaLateral/Build/passadaLateral.framework.js",
    codeUrl: "/unity/PassadaLateral/Build/passadaLateral.wasm",
  });

  useEffect(() => {
    const handleUnityPoint = (dataString: string) => {
        const [peName, spotName] = dataString.split(',');
        if (peName === "PE_ESQUERDO") spotAtualEsq.current = spotName;
        if (peName === "PE_DIREITO") spotAtualDir.current = spotName;
    };

    addEventListener("PontoMarcado", handleUnityPoint as any);
    return () => { removeEventListener("PontoMarcado", handleUnityPoint as any); };
  }, [addEventListener, removeEventListener]);
  
  const unityCommRef = useRef({ isLoaded: false, send: sendMessage });
  useEffect(() => { unityCommRef.current = { isLoaded, send: sendMessage }; }, [isLoaded, sendMessage]);

  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setConfigClinica({ ...configClinica, [name]: value === '' ? '' : Number(value) });
  };

  // ========================================================
  // 4. IA MEDIAPIPE E LOOP DE 60FPS
  // ========================================================
  useEffect(() => {
    let landmarkerObj: PoseLandmarker;

    const carregarIA = async () => {
      const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm");
      landmarkerObj = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`, delegate: "GPU" },
        runningMode: "VIDEO", numPoses: 1
      });
      poseLandmarkerRef.current = landmarkerObj;
      iniciarCamera();
    };

    const iniciarCamera = () => {
      navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
        .then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.onloadedmetadata = () => { videoRef.current?.play(); preverFrames(); };
          }
        });
    };

    const preverFrames = () => {
      if (!videoRef.current || !canvasRef.current || !poseLandmarkerRef.current) return;
      const video = videoRef.current; const canvas = canvasRef.current; const ctx = canvas.getContext("2d");

      if (video.videoWidth === 0) { requestRef.current = requestAnimationFrame(preverFrames); return; }
      if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }

      let startTimeMs = performance.now();
      if (startTimeMs !== tempoUltimoFrameRef.current) {
        tempoUltimoFrameRef.current = startTimeMs;
        const resultados = poseLandmarkerRef.current.detectForVideo(video, startTimeMs);

        if (ctx) {
          ctx.save(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          if (resultados.landmarks && resultados.landmarks[0] && resultados.worldLandmarks && resultados.worldLandmarks[0]) {
            const esqueleto = resultados.landmarks[0]; const esqueletoMundo = resultados.worldLandmarks[0]; 
            const utils = new DrawingUtils(ctx);
            utils.drawConnectors(esqueleto, PoseLandmarker.POSE_CONNECTIONS, { color: "#00FF00", lineWidth: 3 });
            utils.drawLandmarks(esqueleto, { color: "#FF0000", radius: 4 });

            const quadrilEsq = esqueleto[23]; const quadrilDir = esqueleto[24];
            const tornozeloEsq = esqueleto[27]; const tornozeloDir = esqueleto[28];
            const ombroEsq = esqueleto[11]; const ombroDir = esqueleto[12];
            
            if (quadrilEsq.visibility > 0.5 && quadrilDir.visibility > 0.5 && tornozeloEsq.visibility > 0.5 && tornozeloDir.visibility > 0.5) {
                const centroDeMassaX = (quadrilEsq.x + quadrilDir.x) / 2;
                
                if (unityCommRef.current.isLoaded) {
                    unityCommRef.current.send("ReceptorReact", "ReceberPosicaoXDoReact", centroDeMassaX);
                    const dadosPes = `${tornozeloEsq.x.toFixed(4)},${tornozeloDir.x.toFixed(4)}`;
                    unityCommRef.current.send("ReceptorReact", "ReceberPesDoReact", dadosPes);
                }

                if (iniciadoRef.current && !menuAbertoRef.current) {
                    const dx = esqueletoMundo[27].x - esqueletoMundo[28].x; const dy = esqueletoMundo[27].y - esqueletoMundo[28].y; const dz = esqueletoMundo[27].z - esqueletoMundo[28].z;
                    const distanciaCm = Math.round(Math.sqrt(dx*dx + dy*dy + dz*dz) * 100);
                    
                    if (distanciaCm !== refDistancia.current) {
                        refDistancia.current = distanciaCm; setDistanciaAtual(distanciaCm);
                    }
                    
                    let estagioFisica = cicloRef.current.estagio;
                    let novoEstadoVis = refEstadoMovimento.current;

                    const spotEsq = spotAtualEsq.current;
                    const spotDir = spotAtualDir.current;

                    // 1. LÓGICA DE DESCANSO
                    if (estagioFisica === "DESCANSO") {
                        if (refAlertaPostura.current) { refAlertaPostura.current = false; setAlertaPostura(false); } 
                        if (!refEmDescanso.current) { refEmDescanso.current = true; } 

                        const tempoRest = Math.ceil((contagemRef.current.fimDescansoMs - performance.now()) / 1000);
                        
                        if (tempoRest > 0) {
                            if (tempoRest !== refTempoRestante.current) {
                                refTempoRestante.current = tempoRest; setTempoDescansoVisual(tempoRest);
                            }
                            novoEstadoVis = contagemRef.current.tipoDescanso === "SERIE" ? `PAUSA SÉRIE: ${tempoRest}S` : `PAUSA: ${tempoRest}S`;
                        } else {
                            if (contagemRef.current.tipoDescanso === "SERIE") {
                                contagemRef.current.repsEsq = 0; contagemRef.current.repsDir = 0; contagemRef.current.serie++;
                                contagemRef.current.historico.push({ serie: contagemRef.current.serie, corretas: 0, incorretas: 0, compensacoes: 0 });
                                setRepsFeitasEsq(0); setRepsFeitasDir(0); setSerieAtual(contagemRef.current.serie);
                            }
                            cicloRef.current.estagio = "REPOUSO"; novoEstadoVis = "REPOUSO";
                            refEmDescanso.current = false; 
                        }
                    }
                    else if (estagioFisica === "FINALIZADO") {
                        novoEstadoVis = "TREINO CONCLUÍDO!";
                        if (refAlertaPostura.current) { refAlertaPostura.current = false; setAlertaPostura(false); }
                        refEmDescanso.current = false;
                    }
                    // 2. MÁQUINA DE ESTADOS (TOTALMENTE DESBLOQUEADA)
                    else {
                        refEmDescanso.current = false; 
                        
                        // VERIFICAÇÃO DE POSTURA E DISTÂNCIA MÁXIMA
                        const centroOmbrosX = (ombroEsq.x + ombroDir.x) / 2;
                        const compensacaoTronco = Math.abs(centroOmbrosX - centroDeMassaX) * 100;

                        if (estagioFisica !== "REPOUSO") {
                            if (distanciaCm > configRef.current.limiteAbertura) contagemRef.current.repAtualExcedeu = true;
                            // Se desviar mais de 4cm do eixo, marca penalidade no relatório!
                            if (compensacaoTronco > 4) contagemRef.current.repAtualCompensou = true;
                        }

                        // LIGA/DESLIGA AVISO VISUAL NA TELA
                        if (compensacaoTronco > 4) {
                            if (!refAlertaPostura.current) { refAlertaPostura.current = true; setAlertaPostura(true); }
                        } else {
                            if (refAlertaPostura.current) { refAlertaPostura.current = false; setAlertaPostura(false); }
                        }

                        // TRANSIÇÃO DE ESTADOS DA REPETIÇÃO
                        if (estagioFisica === "REPOUSO") {
                            novoEstadoVis = refAlertaPostura.current ? "POSTURA!" : "REPOUSO";
                            if (spotEsq === "ESQUERDO") {
                                cicloRef.current.lado = "ESQUERDA"; cicloRef.current.estagio = "CHEGOU"; novoEstadoVis = "NO DESTINO";
                            } else if (spotDir === "DIREITO") {
                                cicloRef.current.lado = "DIREITA"; cicloRef.current.estagio = "CHEGOU"; novoEstadoVis = "NO DESTINO";
                            }
                        }
                        else if (estagioFisica === "CHEGOU") {
                            novoEstadoVis = refAlertaPostura.current ? "POSTURA!" : "NO DESTINO";
                            if (cicloRef.current.lado === "ESQUERDA" && spotEsq !== "ESQUERDO") {
                                cicloRef.current.estagio = "VOLTANDO"; novoEstadoVis = "RETORNANDO";
                            } else if (cicloRef.current.lado === "DIREITA" && spotDir !== "DIREITO") {
                                cicloRef.current.estagio = "VOLTANDO"; novoEstadoVis = "RETORNANDO";
                            }
                        }
                        else if (estagioFisica === "VOLTANDO") {
                            novoEstadoVis = refAlertaPostura.current ? "POSTURA!" : "RETORNANDO";
                            // Marca ponto se AMBOS os pés baterem no centro OU a distância entre eles for <= 24cm
                            if ((spotEsq === "CENTRO" && spotDir === "CENTRO") || distanciaCm <= 24) {
                                contabilizarRepeticao();
                            }
                        }
                    }

                    if (novoEstadoVis !== refEstadoMovimento.current) {
                        refEstadoMovimento.current = novoEstadoVis; setEstadoMovimento(novoEstadoVis);
                    }
                }
            }

            // GESTOS DE MÃO PARA NAVEGAÇÃO
            const pulsoEsq = esqueleto[15]; const pulsoDir = esqueleto[16];
            const maoEsqLevantada = pulsoEsq.visibility > 0.6 && pulsoEsq.y < ombroEsq.y;
            const maoDirLevantada = pulsoDir.visibility > 0.6 && pulsoDir.y < ombroDir.y;

            if (menuAbertoRef.current) {
                if (maoEsqLevantada) {
                    contadorGestoEsqRef.current += 1; setProgressoEsq((contadorGestoEsqRef.current / 5) * 100);
                    if (contadorGestoEsqRef.current >= 5) { setMenuAberto(false); contadorGestoEsqRef.current = 0; setProgressoEsq(0); }
                } else { contadorGestoEsqRef.current = 0; setProgressoEsq(0); }
                
                if (maoDirLevantada) {
                    contadorGestoDirRef.current += 1; setProgressoDir((contadorGestoDirRef.current / 5) * 100);
                    if (contadorGestoDirRef.current >= 5) { window.location.reload(); }
                } else { contadorGestoDirRef.current = 0; setProgressoDir(0); }
            }
            else if (refEmDescanso.current) {
                if (maoEsqLevantada) {
                    contadorGestoEsqRef.current += 1; setProgressoEsq((contadorGestoEsqRef.current / 10) * 100);
                    if (contadorGestoEsqRef.current >= 10) {
                        const tempoAdd = contagemRef.current.tipoDescanso === "SERIE" ? configRef.current.descansoSerie : configRef.current.descansoRep;
                        contagemRef.current.fimDescansoMs = performance.now() + (tempoAdd * 1000); 
                        contadorGestoEsqRef.current = 0; setProgressoEsq(0);
                    }
                } else { contadorGestoEsqRef.current = 0; setProgressoEsq(0); }
                contadorGestoDirRef.current = 0; setProgressoDir(0); 
            } 
            else if (!iniciadoRef.current) {
                if (maoEsqLevantada) {
                    contadorGestoEsqRef.current += 1; setProgressoInicio((contadorGestoEsqRef.current / 20) * 100);
                    if (contadorGestoEsqRef.current >= 20) { setExercicioIniciado(true); contadorGestoEsqRef.current = 0; setProgressoInicio(0); }
                } else { contadorGestoEsqRef.current = 0; setProgressoInicio(0); }
            } 
            else {
                if (maoDirLevantada && cicloRef.current.estagio !== "FINALIZADO") {
                    contadorGestoDirRef.current += 1; setProgressoDir((contadorGestoDirRef.current / 25) * 100);
                    if (contadorGestoDirRef.current >= 25) { setMenuAberto(true); contadorGestoDirRef.current = 0; setProgressoDir(0); }
                } else { contadorGestoDirRef.current = 0; setProgressoDir(0); }
            }

          }
          ctx.restore();
        }
      }
      requestRef.current = requestAnimationFrame(preverFrames);
    };

    carregarIA();
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (landmarkerObj) landmarkerObj.close();
    };
  }, []);

  const isResting = refEmDescanso.current;

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', backgroundColor: '#1a1a1a', overflow: 'hidden'}}>
      
      {/* BACKGROUND (UNITY) */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }}>
        <Unity unityProvider={unityProvider} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* PIP (CÂMERA) */}
      <div style={{ position: 'absolute', top: '20px', right: '20px', width: '240px', height: '180px', zIndex: 10, backgroundColor: '#000', borderRadius: '12px', border: '3px solid #67B5A2', boxShadow: '0 10px 25px #444E4D', overflow: 'hidden' }}>
          <video ref={videoRef} autoPlay playsInline style={{ display: 'none' }} />
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
          <div style={{ position: 'absolute', bottom: '5px', left: '10px', color: 'white', fontSize: '12px', fontWeight: 'bold', textShadow: '1px 1px 2px black' }}>Câmera</div>
      </div>

      {/* PAINEL CLÍNICO ESQUERDO */}
      <div style={{ position: 'absolute', top: '20px', left: '20px', width: '280px', zIndex: 10 }}>
        <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '15px 20px', borderRadius: '12px', boxShadow: '0 4px 15px #444E4D' }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#333', fontSize: '1.2rem', textAlign: 'center', borderBottom: '2px solid #67B5A2', paddingBottom: '8px' }}>Ajuste Clínico Configurado</h3>
          
          <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Meta Abert. (cm)</label>
              <input type="number" name="metaAbertura" value={configClinica.metaAbertura} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#ef4444', marginBottom: '3px', fontWeight: 'bold' }}>Limite Máx (cm)</label>
              <input type="number" name="limiteAbertura" value={configClinica.limiteAbertura} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Reps Esq:</label>
              <input type="number" name="repsEsquerda" value={configClinica.repsEsquerda} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Reps Dir:</label>
              <input type="number" name="repsDireita" value={configClinica.repsDireita} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Séries Totais:</label>
              <input type="number" name="seriesTotais" value={configClinica.seriesTotais} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Pausa Série (s):</label>
              <input type="number" name="descansoSerie" value={configClinica.descansoSerie} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
          </div>

          <div style={{ marginBottom: '5px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#666', marginBottom: '3px', fontWeight: 'bold' }}>Pausa entre Repetições (s):</label>
            <input type="number" name="descansoRep" value={configClinica.descansoRep} onChange={handleConfigChange} disabled={exercicioIniciado} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
          </div>
        </div>
      </div>
      
      {/* ALERTA GIGANTE DE POSTURA */}
      {alertaPostura && !isResting && !menuAberto && (
        <div style={{ position: 'absolute', top: '25%', left: '50%', transform: 'translate(-50%, -50%)', backgroundColor: '#ef4444', padding: '15px 40px', borderRadius: '20px', border: '4px solid white', zIndex: 45, display: 'flex', alignItems: 'center', gap: '20px', boxShadow: '0 15px 30px rgba(239,68,68,0.6)' }}>
            <span style={{ fontSize: '60px' }}>⚠️</span>
            <div>
                <h1 style={{ color: 'white', margin: 0, fontSize: '1.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Tome cuidado com o Tronco!</h1>
                <p style={{ color: 'white', margin: '5px 0 0 0', fontSize: '1.2rem', fontWeight: 'bold' }}>Mantenha a coluna reta, mantendo sempre a postura.</p>
            </div>
        </div>
      )}

      {/* HUD TOPO */}
      {exercicioIniciado && (
        <div style={{ position: 'absolute', top: '15px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, backgroundColor: 'rgba(26, 26, 26, 0.95)', padding: '15px 35px', borderRadius: '15px', border: '3px solid #67B5A2', display: 'flex', gap: '30px', boxShadow: '0 10px 20px #444E4D' }}>
            <div style={{ borderRight: '1px solid rgba(255,255,255,0.2)', paddingRight: '25px', textAlign: 'center' }}>
                <div style={{ color: '#aaa', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' }}>SÉRIE</div>
                <div style={{ color: 'white', fontSize: '36px', fontWeight: 'bold' }}>{serieAtual} <span style={{fontSize:'18px', color:'#888'}}>/ {configClinica.seriesTotais}</span></div>
            </div>
            
            <div style={{ borderRight: '1px solid rgba(255,255,255,0.2)', paddingRight: '25px', textAlign: 'center' }}>
                <div style={{ color: '#aaa', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' }}>◀ ESQUERDA</div>
                <div style={{ color: '#B02CA0', fontSize: '36px', fontWeight: 'bold' }}>{repsFeitasEsq} <span style={{fontSize:'18px', color:'#888'}}>/ {configClinica.repsEsquerda}</span></div>
            </div>

            <div style={{ borderRight: '1px solid rgba(255,255,255,0.2)', paddingRight: '25px', textAlign: 'center' }}>
                <div style={{ color: '#aaa', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' }}>DIREITA ▶</div>
                <div style={{ color: '#D9BB4E', fontSize: '36px', fontWeight: 'bold' }}>{repsFeitasDir} <span style={{fontSize:'18px', color:'#888'}}>/ {configClinica.repsDireita}</span></div>
            </div>

            <div style={{ textAlign: 'center', minWidth: '160px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ color: '#aaa', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' }}>ESTADO</div>
                <div style={{ color: estadoMovimento.includes("POSTURA") ? "#ef4444" : "#ea580c", fontSize: '20px', fontWeight: 'bold', marginTop: '5px', textTransform: 'uppercase' }}>
                    {estadoMovimento}
                </div>
                <div style={{ color: '#fbbf24', fontSize: '13px', marginTop: '6px', fontWeight: 'bold' }}>Espaço atual entre as pernas: {distanciaAtual} cm</div>
            </div>
        </div>
      )}

      {/* OVERLAY DE INÍCIO */}
      {!exercicioIniciado && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.8)', zIndex: 15, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(5px)' }}>
            <div style={{ fontSize: '80px', marginBottom: '10px' }}>🙋🏽‍♀️</div>
            <h2 style={{ color: 'white', margin: '0 0 20px 0', textAlign: 'center', fontSize: '2.5rem' }}>Vamos Começar? <br/>Levante sua mão esquerda</h2>
            <div style={{ width: '400px', height: '20px', backgroundColor: '#444', borderRadius: '10px', overflow: 'hidden', border: '2px solid white' }}>
                <div style={{ width: `${Math.min(progressoInicio, 100)}%`, height: '100%', backgroundColor: '#67B5A2', transition: 'width 0.1s linear' }} />
            </div>
            <button onClick={() => setExercicioIniciado(true)} style={{ marginTop: '30px', padding: '10px 25px', backgroundColor: 'transparent', color: 'white', border: '1px solid #888', borderRadius: '6px', cursor: 'pointer' }}>Ou... Clique aqui para iniciar!</button>
        </div>
      )}

      {/* OVERLAY DE DESCANSO */}
      {exercicioIniciado && isResting && relatorioFinal.length === 0 && !menuAberto && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.85)', zIndex: 35, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(8px)' }}>
            <div style={{ fontSize: '80px', marginBottom: '10px' }}>⏳</div>
            <h2 style={{ color: '#67B5A2', fontSize: '3rem', margin: 0, textShadow: '2px 2px 4px black' }}>DESCANSO</h2>
            <p style={{ color: 'white', fontSize: '8rem', fontWeight: 'bold', margin: '10px 0', textShadow: '0px 5px 15px rgba(0,0,0,0.8)' }}>{tempoDescansoVisual}</p>
            
            <div style={{ marginTop: '20px', backgroundColor: 'rgba(255,255,255,0.08)', padding: '20px 50px', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: '50px', marginBottom: '10px' }}>✋🏽</span>
                <p style={{ color: '#ddd', fontSize: '1.2rem', margin: '0 0 15px 0', textAlign: 'center' }}>Mão Esquerda<br/><b style={{color: '#67B5A2'}}>REPETIR PAUSA</b></p>
                <div style={{ width: '150px', height: '12px', backgroundColor: '#333', borderRadius: '6px', overflow: 'hidden' }}>
                    <div style={{ width: `${progressoEsq}%`, height: '100%', backgroundColor: '#67B5A2', transition: 'width 0.1s linear' }} />
                </div>
            </div>
        </div>
      )}

      {/* MENU DE PAUSA MANUAL */}
      {menuAberto && relatorioFinal.length === 0 && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 50, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
          <h2 style={{ color: 'white', fontSize: '3rem', marginBottom: '40px', letterSpacing: '2px' }}>EXERCÍCIO PAUSADO</h2>
          
          <div style={{ display: 'flex', gap: '60px' }}>
             <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: 'rgba(34, 197, 94, 0.1)', padding: '30px', borderRadius: '20px', border: '2px solid #22c55e' }}>
                <span style={{ fontSize: '60px', marginBottom: '15px' }}>✋🏽</span>
                <p style={{ color: 'white', fontSize: '1.5rem', margin: '0 0 20px 0', fontWeight: 'bold' }}>Continuar Treino</p>
                <div style={{ width: '200px', height: '15px', backgroundColor: '#333', borderRadius: '8px', overflow: 'hidden' }}>
                    <div style={{ width: `${progressoEsq}%`, height: '100%', backgroundColor: '#22c55e', transition: 'width 0.1s linear' }} />
                </div>
             </div>

             <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '30px', borderRadius: '20px', border: '2px solid #ef4444' }}>
                <span style={{ fontSize: '60px', marginBottom: '15px' }}>🤚🏽</span>
                <p style={{ color: 'white', fontSize: '1.5rem', margin: '0 0 20px 0', fontWeight: 'bold' }}>Encerrar Sessão</p>
                <div style={{ width: '200px', height: '15px', backgroundColor: '#333', borderRadius: '8px', overflow: 'hidden' }}>
                    <div style={{ width: `${progressoDir}%`, height: '100%', backgroundColor: '#ef4444', transition: 'width 0.1s linear' }} />
                </div>
             </div>
          </div>
        </div>
      )}

      {/* POPUP DE RELATÓRIO FINAL */}
      {relatorioFinal.length > 0 && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.85)', zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(8px)' }}>
            <div style={{ backgroundColor: '#67807eb9', padding: '40px', borderRadius: '20px', border: '4px solid #67B5A2', width: '80%', maxWidth: '800px', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 20px 50px #444E4D' }}>
                <h2 style={{ color: 'white', fontSize: '3rem', margin: '0 0 5px 0' }}>Parabéns! Sessão Concluída com Sucesso!</h2>
                <p style={{ color: 'white', marginBottom: '30px', fontSize: '1.2rem' }}>Aqui está o resumo de performance da sua sessão:</p>

                <table style={{ width: '100%', color: 'white', borderCollapse: 'collapse', textAlign: 'center', marginBottom: '40px', fontSize: '1.1rem' }}>
                    <thead>
                        <tr style={{ borderBottom: '3px solid #444', backgroundColor: '#333' }}>
                            <th style={{ padding: '20px' }}>Número da Série</th>
                            <th style={{ padding: '20px', color: '#22c55e' }}>Repetições Realizadas Corretamente</th>
                            <th style={{ padding: '20px', color: '#ef4444' }}>Excedeu Distância Meta</th>
                            <th style={{ padding: '20px', color: '#f59e0b' }}>Postura</th>
                            <th style={{ padding: '20px', color: '#3b82f6' }}>Acurácia</th>
                        </tr>
                    </thead>
                    <tbody>
                        {relatorioFinal.map((r, i) => {
                            const totalReps = r.corretas + r.incorretas;
                            const acuracia = totalReps > 0 ? Math.round((r.corretas / totalReps) * 100) : 0;

                            return (
                                <tr key={i} style={{ borderBottom: '1px solid #333', backgroundColor: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)' }}>
                                    <td style={{ padding: '20px', fontWeight: 'bold' }}>{r.serie}</td>
                                    <td style={{ padding: '20px', fontWeight: 'bold', fontSize: '1.5rem', color: '#22c55e' }}>{r.corretas}</td>
                                    <td style={{ padding: '20px', fontSize: '1.3rem' }}>{r.incorretas}</td>
                                    <td style={{ padding: '20px', fontSize: '1.3rem' }}>{r.compensacoes}</td>
                                    <td style={{ padding: '20px', fontWeight: 'bold', fontSize: '1.5rem', color: '#3b82f6' }}>{acuracia}%</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <button onClick={() => window.location.reload()} style={{ padding: '20px 50px', fontSize: '1.5rem', backgroundColor: '#67B5A2', color: 'white', border: 'none', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 10px 20px #444E4D' }}>
                    Voltar ao Menu Inicial
                </button>
            </div>
        </div>
      )}

    </div>
  );
}