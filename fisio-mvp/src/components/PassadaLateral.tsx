import React, { useRef, useState, useEffect } from 'react';
import { Unity, useUnityContext } from 'react-unity-webgl';
// Imports da IA
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';

export default function PassadaLateral() {
  const [configClinica, setConfigClinica] = useState({ 
    metaAbertura: 30, // Agora isto representa Centímetros!
    repsEsquerda: 5,
    repsDireita: 5,
    seriesTotais: 3,      // Quantas séries no total
    descansoRep: 3,       // Segundos de descanso entre cada repetição
    descansoSerie: 30     // Segundos de descanso ao finalizar uma série
  });
  const [exercicioIniciado, setExercicioIniciado] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const [progressoInicio, setProgressoInicio] = useState(0); // Para a barra laranja do gesto

  // Estados do Placar Dinâmico
  const [serieAtual, setSerieAtual] = useState(1);
  const [repsFeitasEsq, setRepsFeitasEsq] = useState(0); // Conta as da esquerda
  const [repsFeitasDir, setRepsFeitasDir] = useState(0); // Conta as da direita
  const [estadoMovimento, setEstadoMovimento] = useState("REPOUSO");
  const [distanciaAtual, setDistanciaAtual] = useState(0); // Em centímetros

  // Referências da Interface
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Referências do Motor de IA e Gestos
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const requestRef = useRef<number>(0);
  const tempoUltimoFrameRef = useRef<number>(-1);
  const contadorGestoEsqRef = useRef(0); // Conta os frames da mão esquerda levantada
  const contadorGestoDirRef = useRef(0); // Conta os frames da mão direita levantada

  // REFS PARA A BIOMECÂNICA (FASE 3) ---
  const configRef = useRef(configClinica);
  const iniciadoRef = useRef(exercicioIniciado);
  
  // Sincroniza as variáveis de estado com as Refs para a IA conseguir ler em tempo real
  useEffect(() => { configRef.current = configClinica; }, [configClinica]);
  useEffect(() => { iniciadoRef.current = exercicioIniciado; }, [exercicioIniciado]);

  // A "Máquina de Estados" invisível que controla a repetição
  const cicloRef = useRef({ 
    estagio: "REPOUSO", // REPOUSO, INDO, CHEGOU, VOLTANDO
    lado: "",           // ESQUERDA ou DIREITA
    centroOrigemX: 0.5  // Guarda a posição inicial da bacia
  });

  // NOVO: O "Cérebro" para contar repetições e o cronómetro de descanso de forma instantânea
  const contagemRef = useRef({
    repsEsq: 0,
    repsDir: 0,
    serie: 1,
    fimDescansoMs: 0, // Guarda em que milissegundo a pausa deve acabar
    tipoDescanso: ""  // "REP" (Pausa curta) ou "SERIE" (Pausa longa)
  });

  // Para garantir que enviamos mensagens para a Unity sem bugs de renderização
  const { unityProvider, sendMessage, isLoaded } = useUnityContext({
    loaderUrl: "/unity/Joelho/Build/joelho.loader.js", // Mantenha ou ajuste o caminho conforme o seu projeto
    dataUrl: "/unity/Joelho/Build/joelho.data",
    frameworkUrl: "/unity/Joelho/Build/joelho.framework.js",
    codeUrl: "/unity/Joelho/Build/joelho.wasm",
  });
  
  const unityCommRef = useRef({ isLoaded: false, send: sendMessage });
  
  useEffect(() => {
    unityCommRef.current = { isLoaded, send: sendMessage };
  }, [isLoaded, sendMessage]);

  // Função para lidar com a digitação nos inputs
  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setConfigClinica({
      ...configClinica,
      [name]: value === '' ? '' : Number(value)
    });
  };

  // ==========================================
  // MOTOR DE VISÃO COMPUTACIONAL E BIOMECÂNICA
  // ==========================================
  useEffect(() => {
    let landmarkerObj: PoseLandmarker;

    const carregarIA = async () => {
      const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm");
      landmarkerObj = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1
      });
      poseLandmarkerRef.current = landmarkerObj;
      iniciarCamera();
    };

    const iniciarCamera = () => {
      navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
        .then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.onloadedmetadata = () => {
              videoRef.current?.play();
              preverFrames();
            };
          }
        });
    };

    const preverFrames = () => {
      if (!videoRef.current || !canvasRef.current || !poseLandmarkerRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      // TRAVA DE SEGURANÇA ANTI-CRASH
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        requestRef.current = requestAnimationFrame(preverFrames);
        return;
      }

      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      let startTimeMs = performance.now();
      if (startTimeMs !== tempoUltimoFrameRef.current) {
        tempoUltimoFrameRef.current = startTimeMs;
        const resultados = poseLandmarkerRef.current.detectForVideo(video, startTimeMs);

        if (ctx) {
          ctx.save();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // NOVO: Exige os landmarks em 2D (ecrã) e em 3D (mundo real)
          if (resultados.landmarks && resultados.landmarks[0] && resultados.worldLandmarks && resultados.worldLandmarks[0]) {
            const esqueleto = resultados.landmarks[0];
            const esqueletoMundo = resultados.worldLandmarks[0]; // Dados em metros 3D
            const utils = new DrawingUtils(ctx);
            
            // Desenha o esqueleto a verde
            utils.drawConnectors(esqueleto, PoseLandmarker.POSE_CONNECTIONS, { color: "#00FF00", lineWidth: 3 });
            utils.drawLandmarks(esqueleto, { color: "#FF0000", radius: 4 });

            // ==========================================
            // 1. A FÍSICA E BIOMECÂNICA DA PASSADA
            // ==========================================
            const quadrilEsq = esqueleto[23];
            const quadrilDir = esqueleto[24];
            const tornozeloEsq = esqueleto[27];
            const tornozeloDir = esqueleto[28];
            const ombroEsq = esqueleto[11];
            const ombroDir = esqueleto[12];
            
            // Exige a visibilidade de ambos os tornozelos para evitar falhas!
            if (quadrilEsq.visibility > 0.5 && quadrilDir.visibility > 0.5 && tornozeloEsq.visibility > 0.5 && tornozeloDir.visibility > 0.5) {
                
                const centroDeMassaX = (quadrilEsq.x + quadrilDir.x) / 2;
                // A comunicação com a Unity não terá efeito visual até a Fase 4
                if (unityCommRef.current.isLoaded) {
                    unityCommRef.current.send("ReceptorReact", "ReceberPosicaoXDoReact", centroDeMassaX);
                }

                if (iniciadoRef.current) {
                    // CÁLCULO 3D EM CENTÍMETROS
                    const tornozeloEsqMundo = esqueletoMundo[27];
                    const tornozeloDirMundo = esqueletoMundo[28];
                    
                    const dx = tornozeloEsqMundo.x - tornozeloDirMundo.x;
                    const dy = tornozeloEsqMundo.y - tornozeloDirMundo.y;
                    const dz = tornozeloEsqMundo.z - tornozeloDirMundo.z;
                    
                    const distanciaMetros = Math.sqrt(dx*dx + dy*dy + dz*dz);
                    const distanciaCm = Math.round(distanciaMetros * 100);
                    
                    setDistanciaAtual(distanciaCm); // Exibe o valor em CM na tela
                    
                    const centroOmbrosX = (ombroEsq.x + ombroDir.x) / 2;
                    const compensacaoTronco = Math.abs(centroOmbrosX - centroDeMassaX) * 100;
                    
                    if (compensacaoTronco > 12) {
                        setEstadoMovimento("POSTURA!");
                    } else {

                        const metaCm = configRef.current.metaAbertura;
                        let estagioAtual = cicloRef.current.estagio;
                        
                        // FLUXO DE ESTADOS (A Lógica do Vai e Vem)
                        if (estagioAtual === "REPOUSO") {
                            // Pés juntos anatomicamente rondam os 10~20cm
                            if (distanciaCm < 22) {
                                // Pés juntos: calibra onde é o "Centro" do paciente
                                cicloRef.current.centroOrigemX = centroDeMassaX; 
                                setEstadoMovimento("REPOUSO");
                            } 
                            else if (distanciaCm >= metaCm) {
                                // Pés afastados além da meta: O movimento começou!
                                cicloRef.current.estagio = "INDO";
                                // Verifica para que lado a bacia se moveu em relação à origem
                                cicloRef.current.lado = (centroDeMassaX < cicloRef.current.centroOrigemX) ? "DIREITA" : "ESQUERDA";
                                setEstadoMovimento(`ABRINDO (${cicloRef.current.lado})`);
                            }
                        } 
                        else if (estagioAtual === "INDO") {
                            if (distanciaCm < 22) { 
                                // Juntou os pés no destino
                                cicloRef.current.estagio = "CHEGOU";
                                setEstadoMovimento("NO DESTINO");
                            }
                        }
                        else if (estagioAtual === "CHEGOU") {
                            if (distanciaCm >= metaCm) { 
                                // Abriu a perna para voltar ao centro
                                cicloRef.current.estagio = "VOLTANDO";
                                setEstadoMovimento("RETORNANDO");
                            }
                        }
                        else if (estagioAtual === "VOLTANDO") {
                            if (distanciaCm < 22) { 
                                // 1. MARCA O PONTO!
                                let repsEsqAtual = contagemRef.current.repsEsq;
                                let repsDirAtual = contagemRef.current.repsDir;

                                if (cicloRef.current.lado === "DIREITA") {
                                    repsDirAtual++;
                                    contagemRef.current.repsDir = repsDirAtual;
                                    setRepsFeitasDir(repsDirAtual);
                                } else {
                                    repsEsqAtual++;
                                    contagemRef.current.repsEsq = repsEsqAtual;
                                    setRepsFeitasEsq(repsEsqAtual);
                                }

                                // 2. VERIFICA SE A SÉRIE ACABOU
                                const totalRepsMeta = configRef.current.repsEsquerda + configRef.current.repsDireita;
                                const totalRepsFeitas = repsEsqAtual + repsDirAtual;

                                if (totalRepsFeitas >= totalRepsMeta) {
                                    // SÉRIE CONCLUÍDA!
                                    if (contagemRef.current.serie < configRef.current.seriesTotais) {
                                        cicloRef.current.estagio = "DESCANSO";
                                        contagemRef.current.tipoDescanso = "SERIE";
                                        contagemRef.current.fimDescansoMs = performance.now() + (configRef.current.descansoSerie * 1000);
                                    } else {
                                        // FIM DO TREINO
                                        cicloRef.current.estagio = "FINALIZADO";
                                        setEstadoMovimento("TREINO CONCLUÍDO!");
                                    }
                                } else {
                                    // APENAS MAIS UMA REPETIÇÃO
                                    cicloRef.current.estagio = "DESCANSO";
                                    contagemRef.current.tipoDescanso = "REP";
                                    contagemRef.current.fimDescansoMs = performance.now() + (configRef.current.descansoRep * 1000);
                                }
                            }
                        }
                        // NOVO ESTADO: O CRONÓMETRO DE DESCANSO
                        else if (estagioAtual === "DESCANSO") {
                            // Calcula quantos segundos faltam
                            const tempoRestante = Math.ceil((contagemRef.current.fimDescansoMs - performance.now()) / 1000);

                            if (tempoRestante > 0) {
                                // Atualiza o placar com a contagem regressiva
                                if (contagemRef.current.tipoDescanso === "SERIE") {
                                    setEstadoMovimento(`PAUSA SÉRIE: ${tempoRestante}s`);
                                } else {
                                    setEstadoMovimento(`PAUSA: ${tempoRestante}s`);
                                }
                            } else {
                                // O DESCANSO ACABOU!
                                if (contagemRef.current.tipoDescanso === "SERIE") {
                                    // Zera os contadores e vai para a próxima série
                                    contagemRef.current.repsEsq = 0;
                                    contagemRef.current.repsDir = 0;
                                    contagemRef.current.serie++;
                                    
                                    setRepsFeitasEsq(0);
                                    setRepsFeitasDir(0);
                                    setSerieAtual(contagemRef.current.serie);
                                }
                                
                                // Libera para a próxima passada
                                cicloRef.current.estagio = "REPOUSO";
                                setEstadoMovimento("REPOUSO");
                            }
                        }
                    }
                }
            }

            // 2. OS GESTOS 
            const pulsoEsq = esqueleto[15];
            const pulsoDir = esqueleto[16];

            // LÓGICA MÃO ESQUERDA (INICIAR) 
            setExercicioIniciado((iniciadoAtual) => {
              if (!iniciadoAtual && pulsoEsq.y < ombroEsq.y) {
                contadorGestoEsqRef.current += 1;
                setProgressoInicio((contadorGestoEsqRef.current / 40) * 100);
                
                if (contadorGestoEsqRef.current >= 40) {
                  return true; // Aciona o Início
                }
              } else if (!iniciadoAtual) {
                contadorGestoEsqRef.current = 0;
                setProgressoInicio(0);
              }
              return iniciadoAtual;
            });

            // LÓGICA MÃO DIREITA (PAUSAR) 
            setExercicioIniciado((iniciadoAtual) => {
              if (iniciadoAtual && pulsoDir.y < ombroDir.y) {
                contadorGestoDirRef.current += 1;
                if (contadorGestoDirRef.current >= 30) {
                  setMenuAberto(true); // Abre a tela preta de Pause
                  contadorGestoDirRef.current = 0; // Zera para não abrir em loop
                }
              } else {
                contadorGestoDirRef.current = 0;
              }
              return iniciadoAtual;
            });
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

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', backgroundColor: '#1a1a1a', overflow: 'hidden' }}>
      
      {/* ========================================== */}
      {/* CAMADA 1: UNITY EM TELA CHEIA (FUNDO)      */}
      {/* ========================================== */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }}>
        <Unity unityProvider={unityProvider} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* ========================================== */}
      {/* CAMADA 2: PICTURE-IN-PICTURE (PACIENTE)    */}
      {/* ========================================== */}
      <div style={{ 
          position: 'absolute', 
          top: '20px', 
          right: '20px', 
          width: '240px',   // Reduzido
          height: '180px',  // Reduzido
          zIndex: 10, 
          backgroundColor: '#000',
          borderRadius: '12px', 
          border: '3px solid #ea580c',
          boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
          overflow: 'hidden'
      }}>
          <video ref={videoRef} autoPlay playsInline style={{ display: 'none' }} />
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
          
          {/* Etiqueta na câmara */}
          <div style={{ position: 'absolute', bottom: '5px', left: '10px', color: 'white', fontSize: '12px', fontWeight: 'bold', textShadow: '1px 1px 2px black' }}>
            Câmara do Paciente
          </div>
      </div>

      {/* ========================================== */}
      {/* CAMADA 3: PAINEL CLÍNICO E HUD             */}
      {/* ========================================== */}
      <div style={{ 
          position: 'absolute', 
          top: '20px', 
          left: '20px', 
          width: '300px', 
          zIndex: 10, 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '15px' 
      }}>
        
        {/* Caixa de Ajustes Clínicos */}
        <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginTop: 0, color: '#333', fontSize: '1.2rem' }}>Ajuste Clínico (Passada)</h3>
          
          {/* Meta de Abertura */}
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', fontSize: '14px', color: '#666', marginBottom: '5px' }}>
              Meta de Abertura (cm):
            </label>
            <input 
              type="number" 
              name="metaAbertura" 
              value={configClinica.metaAbertura} 
              onChange={handleConfigChange}
              disabled={exercicioIniciado}
              style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>

         {/* Inputs Divididos Lado a Lado (Corrigido) */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
            <div style={{ width: '48%' }}>
              <label style={{ display: 'block', fontSize: '13px', color: '#666', marginBottom: '5px' }}>
                Reps Esq:
              </label>
              <input 
                type="number" 
                name="repsEsquerda" 
                value={configClinica.repsEsquerda} 
                onChange={handleConfigChange} 
                disabled={exercicioIniciado} 
                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} 
              />
            </div>
            
            <div style={{ width: '48%' }}>
              <label style={{ display: 'block', fontSize: '13px', color: '#666', marginBottom: '5px' }}>
                Reps Dir:
              </label>
              <input 
                type="number" 
                name="repsDireita" 
                value={configClinica.repsDireita} 
                onChange={handleConfigChange} 
                disabled={exercicioIniciado} 
                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} 
              />
            </div>
          </div>
          
          <small style={{ display: 'block', color: '#888', fontSize: '11px', marginBottom: '15px', textAlign: 'center' }}>
            Total da Série: {configClinica.repsEsquerda + configClinica.repsDireita} repetições
          </small>

          {/* NOVO BLOCO: Séries e Descansos */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ width: '48%' }}>
              <label style={{ display: 'block', fontSize: '13px', color: '#666', marginBottom: '5px' }}>
                Séries Totais:
              </label>
              <input 
                type="number" 
                name="seriesTotais" 
                value={configClinica.seriesTotais} 
                onChange={handleConfigChange} 
                disabled={exercicioIniciado} 
                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} 
              />
            </div>
            
            <div style={{ width: '48%' }}>
              <label style={{ display: 'block', fontSize: '13px', color: '#666', marginBottom: '5px' }}>
                Pausa Série (s):
              </label>
              <input 
                type="number" 
                name="descansoSerie" 
                value={configClinica.descansoSerie} 
                onChange={handleConfigChange} 
                disabled={exercicioIniciado} 
                style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} 
              />
            </div>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#666', marginBottom: '5px' }}>
              Pausa entre Repetições (s):
            </label>
            <input 
              type="number" 
              name="descansoRep" 
              value={configClinica.descansoRep} 
              onChange={handleConfigChange}
              disabled={exercicioIniciado}
              style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
            />
          </div>

          {!exercicioIniciado && (
            <button 
              onClick={() => setExercicioIniciado(true)}
              style={{ width: '100%', padding: '10px', backgroundColor: '#ea580c', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px' }}
            >
              Iniciar Exercício
            </button>
          )}

          {/* Feedback Visual do Gesto (Mão Esquerda) */}
          {!exercicioIniciado && progressoInicio > 0 && (
             <div style={{ marginTop: '10px', width: '100%', height: '10px', backgroundColor: '#ddd', borderRadius: '5px', overflow: 'hidden' }}>
               <div style={{ width: `${Math.min(progressoInicio, 100)}%`, height: '100%', backgroundColor: '#ea580c', transition: 'width 0.1s linear' }} />
             </div>
          )}
        </div>

        {/* Placar (HUD) entrará aqui depois */}
      </div>
      
      {/* ========================================== */}
      {/* CAMADA 3.5: PLACAR DINÂMICO CENTRAL (HUD)  */}
      {/* ========================================== */}
      {exercicioIniciado && (
        <div style={{ 
            position: 'absolute', 
            top: '15px', 
            left: '50%', 
            transform: 'translateX(-50%)', 
            width: '540px', // Um pouco mais largo para caber tudo numa linha
            backgroundColor: 'rgba(0, 0, 0, 0.85)', 
            padding: '10px 20px', // Altura reduzida
            borderRadius: '12px', 
            border: '2px solid #ea580c',
            color: 'white',
            display: 'flex', 
            flexDirection: 'column', 
            zIndex: 20,
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(4px)'
        }}>
          {/* Informações de Texto Alinhadas */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            
            {/* LADO ESQUERDO */}
            <div style={{ textAlign: 'left', width: '25%' }}>
              <span style={{ fontSize: '10px', color: '#aaa', fontWeight: 'bold', letterSpacing: '1px' }}>◀ ESQUERDA</span><br/>
              <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#3b82f6' }}>
                {repsFeitasEsq} <span style={{ fontSize: '14px', color: '#fff' }}>/ {configClinica.repsEsquerda}</span>
              </span>
            </div>

            {/* CENTRO: SÉRIE E ESTADO */}
            <div style={{ textAlign: 'center', width: '50%', borderLeft: '1px solid #444', borderRight: '1px solid #444', padding: '0 10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
                  <div>
                      <span style={{ fontSize: '10px', color: '#aaa', fontWeight: 'bold', letterSpacing: '1px' }}>SÉRIE</span><br/>
                      <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{serieAtual} <span style={{ fontSize: '12px', color: '#888' }}>/ {configClinica.seriesTotais}</span></span>
                  </div>
                  <div>
                      <span style={{ fontSize: '10px', color: '#aaa', fontWeight: 'bold', letterSpacing: '1px' }}>ESTADO</span><br/>
                      <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#ea580c', textTransform: 'uppercase' }}>{estadoMovimento}</span>
                  </div>
              </div>
            </div>

            {/* LADO DIREITO */}
            <div style={{ textAlign: 'right', width: '25%' }}>
              <span style={{ fontSize: '10px', color: '#aaa', fontWeight: 'bold', letterSpacing: '1px' }}>DIREITA ▶</span><br/>
              <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#a855f7' }}>
                {repsFeitasDir} <span style={{ fontSize: '14px', color: '#fff' }}>/ {configClinica.repsDireita}</span>
              </span>
              {/* O SENSOR EM TEMPO REAL ATUALIZADO */}
              <div style={{ marginTop: '5px', fontSize: '11px', color: '#fbbf24' }}>
                Abertura Atual: {distanciaAtual} cm
              </div>
            </div>

          </div>

          {/* Barra de Progresso Dinâmica (Total da Série) */}
          <div style={{ width: '100%', height: '8px', backgroundColor: '#333', borderRadius: '4px', overflow: 'hidden', border: '1px solid #000' }}>
            <div style={{ 
                width: `${((repsFeitasEsq + repsFeitasDir) / (configClinica.repsEsquerda + configClinica.repsDireita)) * 100}%`, 
                height: '100%', 
                backgroundColor: '#22c55e', 
                transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 0 10px rgba(34, 197, 94, 0.5)'
            }} />
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* CAMADA 4: MENU DE PAUSA (Sobreposto a tudo) */}
      {/* ========================================== */}
      {menuAberto && (
        <div style={{ 
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', 
            backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 50, 
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(5px)'
        }}>
          <h2 style={{ color: 'white', fontSize: '2.5rem', marginBottom: '30px' }}>⏸️ Exercício Pausado</h2>
          
          <div style={{ display: 'flex', gap: '20px' }}>
            <button 
              onClick={() => setMenuAberto(false)} 
              style={{ padding: '15px 30px', fontSize: '1.2rem', backgroundColor: '#22c55e', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              ▶️ Continuar Treino
            </button>
            
            <button 
              onClick={() => {
                setMenuAberto(false);
                setExercicioIniciado(false);
              }} 
              style={{ padding: '15px 30px', fontSize: '1.2rem', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              🛑 Encerrar Sessão
            </button>
          </div>
        </div>
      )}
    
    </div>
  );
}