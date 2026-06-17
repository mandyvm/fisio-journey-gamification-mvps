import { useEffect, useRef, useState } from 'react';
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { Unity, useUnityContext } from "react-unity-webgl";

export const MocapCamera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // ========================================================
  // A LIGAÇÃO COM O JOGO
  // ========================================================
  const { unityProvider, sendMessage, isLoaded: isUnityLoaded } = useUnityContext({
    loaderUrl: "/unity/Joelho/Build/joelho.loader.js",
    dataUrl: "/unity/Joelho/Build/joelho.data",
    frameworkUrl: "/unity/Joelho/Build/joelho.framework.js",
    codeUrl: "/unity/Joelho/Build/joelho.wasm",
  });
  
  const unityCommRef = useRef({ isLoaded: false, send: sendMessage });
  useEffect(() => {
    unityCommRef.current.isLoaded = isUnityLoaded;
    unityCommRef.current.send = sendMessage;
  }, [isUnityLoaded, sendMessage]);
  
  // ========================================================
  // PARÂMETROS CLÍNICOS (ATUALIZADO COM SÉRIES E TEMPOS)
  // ========================================================
  const [configClinica, setConfigClinica] = useState({
    ladoAtivo: "esquerdo",
    repousoMax: 110,
    meta: 145,
    tolerancia: 5,
    limiteTronco: 15,
    // NOVAS VARIÁVEIS DE PRESCRIÇÃO:
    series: 1,
    repeticoesPorSerie: 5,
    descansoRepeticao: 3, // Segundos entre repetições
    descansoSerie: 30     // Segundos entre séries completas
  });

  const configRef = useRef(configClinica);
  useEffect(() => {
    configRef.current = configClinica;
  }, [configClinica]);

  useEffect(() => {
    if (unityCommRef.current.isLoaded) {
      unityCommRef.current.send("ReceptorReact", "ReceberLadoAtivoDoReact", configClinica.ladoAtivo);
    }
  }, [configClinica.ladoAtivo, isUnityLoaded]);

  // ========================================================
  // ESTADOS DO HUD E CONTROLO DE TEMPO
  // ========================================================
  const [exercicioIniciado, setExercicioIniciado] = useState(false);
  const [progressoInicio, setProgressoInicio] = useState(0); 
  
  const [serieAtual, setSerieAtual] = useState(1);
  const [repeticoes, setRepeticoes] = useState(0);
  const [estagio, setEstagio] = useState("REPOUSO");
  const [alertaPostura, setAlertaPostura] = useState(false); 
  
  // Estado para o cronómetro visual
  const [tempoDescansoVisual, setTempoDescansoVisual] = useState(0);
  const [emDescanso, setEmDescanso] = useState(false);

  const exercicioIniciadoRef = useRef(false);
  const contadorGestoRef = useRef(0); 
  const ultimoEsqueletoRef = useRef<any[] | null>(null);
  
  const contadorRef = useRef(0);
  const serieCountRef = useRef(1);
  const estagioRef = useRef("REPOUSO");
  const alertaRef = useRef(false);
  
  // Ref para controlar a lógica de tempo por trás dos panos
  const cronometroRef = useRef({ ativo: false, fim: 0 });

  const calcularAngulo = (pontoA: any, pontoB: any, pontoC: any) => {
    const radianos = Math.atan2(pontoC.y - pontoB.y, pontoC.x - pontoB.x) -
                     Math.atan2(pontoA.y - pontoB.y, pontoA.x - pontoB.x);
    let angulo = Math.abs(radianos * 180.0 / Math.PI);
    if (angulo > 180.0) angulo = 360.0 - angulo;
    return angulo;
  };

  const calcularInclinacaoTronco = (ombro: any, anca: any) => {
    const dx = Math.abs(ombro.x - anca.x);
    const dy = Math.abs(ombro.y - anca.y);
    const inclinacao = Math.atan2(dx, dy) * (180.0 / Math.PI);
    return inclinacao;
  };

  const atualizarHUD = (novoEstagio: string, novoContador: number, compensando: boolean) => {
    if (estagioRef.current !== novoEstagio) {
      estagioRef.current = novoEstagio;
      setEstagio(novoEstagio);
      
      if (unityCommRef.current.isLoaded) {
          // TRUQUE: Se o React diz "DESCANSO" ou "FINALIZADO", mandamos "REPOUSO" para a Unity apagar a bola
          const estadoUnity = (novoEstagio === "DESCANSO" || novoEstagio === "FINALIZADO") ? "REPOUSO" : novoEstagio;
          unityCommRef.current.send("ReceptorReact", "ReceberEstadoDoReact", estadoUnity);
      }
    }
    if (contadorRef.current !== novoContador) {
      contadorRef.current = novoContador;
      setRepeticoes(novoContador);
    }
    if (alertaRef.current !== compensando) {
        alertaRef.current = compensando;
        setAlertaPostura(compensando);
        if (compensando && unityCommRef.current.isLoaded) {
            unityCommRef.current.send("ReceptorReact", "ReceberEstadoDoReact", "POSTURA!");
        }
    }
  };

  useEffect(() => {
    let poseLandmarker: PoseLandmarker;
    let animationFrameId: number;

    const inicializarMediaPipe = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
      setIsLoaded(true);
      ligarCamera();
    };

    const ligarCamera = () => {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.addEventListener("loadeddata", preverFrames);
          }
        });
      }
    };

    const preverFrames = () => {
      if (!videoRef.current || !canvasRef.current || !poseLandmarker) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        animationFrameId = window.requestAnimationFrame(preverFrames);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      let startTimeMs = performance.now();
      const resultados = poseLandmarker.detectForVideo(video, startTimeMs);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      if (resultados.landmarks && resultados.landmarks.length > 0) {
        const esqueletoCru = resultados.landmarks[0];
        let esqueletoSuavizado = [];
        const fatorSuavizacao = 0.4; 

        if (!ultimoEsqueletoRef.current) {
            esqueletoSuavizado = esqueletoCru;
        } else {
            for (let i = 0; i < esqueletoCru.length; i++) {
                const pontoAntigo = ultimoEsqueletoRef.current[i];
                const pontoNovo = esqueletoCru[i];
                const confiabilidade = pontoNovo.visibility || 0;
                if (confiabilidade > 0.4) {
                    esqueletoSuavizado.push({
                        x: pontoAntigo.x + (pontoNovo.x - pontoAntigo.x) * fatorSuavizacao,
                        y: pontoAntigo.y + (pontoNovo.y - pontoAntigo.y) * fatorSuavizacao,
                        z: pontoAntigo.z + (pontoNovo.z - pontoAntigo.z) * fatorSuavizacao,
                        visibility: confiabilidade
                    });
                } else {
                    esqueletoSuavizado.push({
                        x: pontoAntigo.x, y: pontoAntigo.y, z: pontoAntigo.z, visibility: 0 
                    });
                }
            }
        }
        ultimoEsqueletoRef.current = esqueletoSuavizado;
        const drawingUtils = new DrawingUtils(ctx);
        drawingUtils.drawConnectors(esqueletoSuavizado, PoseLandmarker.POSE_CONNECTIONS, { color: "#00FF00", lineWidth: 4 });
        drawingUtils.drawLandmarks(esqueletoSuavizado, { color: "#FF0000", radius: 4 });

        // GESTO DE INÍCIO
        if (!exercicioIniciadoRef.current) {
            const nariz = esqueletoSuavizado[0];
            const pulsoEsquerdo = esqueletoSuavizado[15];
            const pulsoDireito = esqueletoSuavizado[16];

            if (nariz.visibility > 0.5) {
                const levantouMaoEsquerda = pulsoEsquerdo.visibility > 0.7 && pulsoEsquerdo.y < nariz.y;
                const levantouMaoDireita = pulsoDireito.visibility > 0.7 && pulsoDireito.y < nariz.y;

                if (levantouMaoEsquerda || levantouMaoDireita) {
                    contadorGestoRef.current += 1;
                    if (contadorGestoRef.current >= 25) {
                        exercicioIniciadoRef.current = true;
                        setExercicioIniciado(true);
                    }
                } else {
                    contadorGestoRef.current = 0;
                }
                setProgressoInicio(Math.min(100, (contadorGestoRef.current / 25) * 100));
            }
        } 
        // LÓGICA DO EXERCÍCIO (COM CRONÓMETRO)
        else {
            const configAtual = configRef.current;
            let ombro, anca, joelho, tornozelo;

            if (configAtual.ladoAtivo === "direito") {
                ombro = esqueletoSuavizado[12]; anca = esqueletoSuavizado[24];
                joelho = esqueletoSuavizado[26]; tornozelo = esqueletoSuavizado[28];
            } else {
                ombro = esqueletoSuavizado[11]; anca = esqueletoSuavizado[23];
                joelho = esqueletoSuavizado[25]; tornozelo = esqueletoSuavizado[27];
            }

            if (ombro.visibility > 0.4 && anca.visibility > 0.4 && joelho.visibility > 0.4 && tornozelo.visibility > 0.4) {
                
                const anguloPerna = calcularAngulo(anca, joelho, tornozelo);
                const inclinacaoTronco = calcularInclinacaoTronco(ombro, anca);
                
                if (unityCommRef.current.isLoaded) {
                    unityCommRef.current.send("ReceptorReact", "ReceberAnguloDoReact", anguloPerna);
                }
                
                let estaCompensando = inclinacaoTronco > configAtual.limiteTronco;
                let estadoTemp = estagioRef.current;
                
                // 1. VERIFICA SE O EXERCÍCIO JÁ TERMINOU TODAS AS SÉRIES
                if (estadoTemp === "FINALIZADO") {
                    atualizarHUD("FINALIZADO", contadorRef.current, false);
                } 
                // 2. VERIFICA SE ESTÁ A DESCANSAR (O Tempo congela a física)
                else if (cronometroRef.current.ativo) {
                    const faltamSecs = Math.ceil((cronometroRef.current.fim - startTimeMs) / 1000);
                    if (faltamSecs > 0) {
                        setTempoDescansoVisual(faltamSecs);
                        estadoTemp = "DESCANSO";
                        estaCompensando = false; // Não há alerta de postura enquanto descansa
                    } else {
                        // Tempo acabou!
                        cronometroRef.current.ativo = false;
                        setEmDescanso(false);
                        estadoTemp = "REPOUSO";
                    }
                    atualizarHUD(estadoTemp, contadorRef.current, estaCompensando);
                } 
                // 3. FLUXO NORMAL DO EXERCÍCIO
                else {
                    const metaComTolerancia = configAtual.meta * (1 - (configAtual.tolerancia / 100));

                    if (estaCompensando) {
                        estadoTemp = "POSTURA!";
                    } 
                    else {
                        if (anguloPerna <= configAtual.repousoMax) {
                            
                            // SE ELE ACABOU DE DESCER A PERNA (RETORNANDO -> REPOUSO)
                            if (estadoTemp === "RETORNANDO") {
                                const acabouSerie = contadorRef.current >= configAtual.repeticoesPorSerie;
                                
                                if (acabouSerie) {
                                    if (serieCountRef.current >= configAtual.series) {
                                        estadoTemp = "FINALIZADO"; // Fim de tudo!
                                    } else {
                                        // Inicia descanso de SÉRIE
                                        serieCountRef.current += 1;
                                        setSerieAtual(serieCountRef.current);
                                        contadorRef.current = 0; // Zera as reps para a nova série
                                        cronometroRef.current = { ativo: true, fim: startTimeMs + (configAtual.descansoSerie * 1000) };
                                        setEmDescanso(true);
                                        estadoTemp = "DESCANSO";
                                    }
                                } else {
                                    // Inicia descanso de REPETIÇÃO
                                    if (configAtual.descansoRepeticao > 0) {
                                        cronometroRef.current = { ativo: true, fim: startTimeMs + (configAtual.descansoRepeticao * 1000) };
                                        setEmDescanso(true);
                                        estadoTemp = "DESCANSO";
                                    } else {
                                        estadoTemp = "REPOUSO";
                                    }
                                }
                            } else {
                                estadoTemp = "REPOUSO";
                            }
                        } 
                        else if (anguloPerna >= metaComTolerancia) {
                            if (estadoTemp === "CONTRACAO" || estadoTemp === "REPOUSO") {
                                estadoTemp = "SUCESSO";
                                contadorRef.current += 1;
                            } else if (estadoTemp === "SUCESSO") {
                                estadoTemp = "SUCESSO";
                            } else {
                                estadoTemp = "RETORNANDO"; 
                            }
                        }
                        else {
                            if (estadoTemp === "REPOUSO" || estadoTemp === "CONTRACAO") {
                                estadoTemp = "CONTRACAO"; 
                            } 
                            else if (estadoTemp === "SUCESSO" || estadoTemp === "RETORNANDO" || estadoTemp === "POSTURA!") {
                                estadoTemp = "RETORNANDO"; 
                            }
                        }
                    }
                    atualizarHUD(estadoTemp, contadorRef.current, estaCompensando);
                }

                // Desenhos na Câmara
                ctx.fillStyle = "#FFFFFF"; 
                ctx.font = "bold 30px Arial";
                ctx.strokeStyle = "#000000";
                ctx.lineWidth = 3;

                ctx.save();
                ctx.translate(joelho.x * canvas.width + 20, joelho.y * canvas.height);
                ctx.scale(-1, 1); 
                ctx.strokeText(Math.round(anguloPerna) + "°", 0, 0);
                ctx.fillText(Math.round(anguloPerna) + "°", 0, 0);
                ctx.restore();

                ctx.fillStyle = estaCompensando ? "#FF0000" : "#00FFFF"; 
                ctx.save();
                ctx.translate(anca.x * canvas.width + 20, anca.y * canvas.height - 30);
                ctx.scale(-1, 1); 
                ctx.strokeText("Tronco: " + Math.round(inclinacaoTronco) + "°", 0, 0);
                ctx.fillText("Tronco: " + Math.round(inclinacaoTronco) + "°", 0, 0);
                ctx.restore();
            }
        }
      } else {
        ultimoEsqueletoRef.current = null;
      }
      animationFrameId = window.requestAnimationFrame(preverFrames);
    };

    inicializarMediaPipe();

    return () => {
      if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
      if (poseLandmarker) poseLandmarker.close();
    };
  }, []); 

  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    
    setConfigClinica({
      ...configClinica,
      // Se for número e estiver vazio (apagado), mantém vazio string para conseguir digitar. 
      // Se tiver valor, converte para Number.
      [name]: type === 'number' ? (value === '' ? '' : Number(value)) : value
    });
  };

  const corDoEstado = alertaPostura ? "#FF0000" : 
                      estagio === "SUCESSO" ? "#00FF00" : 
                      estagio === "CONTRACAO" ? "#FFA500" : 
                      estagio === "RETORNANDO" ? "#FFD700" : 
                      estagio === "DESCANSO" ? "#00FFFF" :
                      estagio === "FINALIZADO" ? "#00FF00" : "#FFFFFF";

  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100vw', height: '100vh', margin: 0, padding: 0, fontFamily: 'sans-serif', boxSizing: 'border-box', backgroundColor: '#fff', position: 'absolute', top: 0, left: 0 }}>
      
      {/* LADO ESQUERDO */}
      <div style={{ display: 'flex', flexDirection: 'column', width: '50%', height: '100%', borderRight: '2px solid #ea580c', boxSizing: 'border-box', backgroundColor: '#f9f9f9' }}>
        
        {/* CÂMARA */}
        <div style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0, backgroundColor: '#222', overflow: 'hidden' }}>
          {!isLoaded && <p style={{ color: 'white', padding: '20px', zIndex: 10 }}>A carregar IA...</p>}
          
          {isLoaded && !exercicioIniciado && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.7)', zIndex: 20, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(3px)' }}>
                <div style={{ fontSize: '50px', marginBottom: '10px' }}>🙋🏽‍♀️</div>
                <h2 style={{ color: 'white', margin: '0 0 20px 0', textAlign: 'center', fontSize: '1.5rem' }}>Levante e segure a mão<br/>para começar</h2>
                <div style={{ width: '200px', height: '10px', backgroundColor: '#444', borderRadius: '5px', overflow: 'hidden' }}>
                    <div style={{ width: `${progressoInicio}%`, height: '100%', backgroundColor: '#ea580c', transition: 'width 0.1s linear' }} />
                </div>
            </div>
          )}

          {/* OVERLAY DE DESCANSO GIGANTE NO MEIO DA TELA */}
          {exercicioIniciado && emDescanso && estagio !== "FINALIZADO" && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.6)', zIndex: 15, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(2px)' }}>
                <div style={{ fontSize: '60px', marginBottom: '10px' }}>⏳</div>
                <h2 style={{ color: '#00FFFF', fontSize: '2rem', margin: 0 }}>DESCANSO</h2>
                <p style={{ color: 'white', fontSize: '5rem', fontWeight: 'bold', margin: '10px 0' }}>{tempoDescansoVisual}</p>
                <p style={{ color: '#ddd', fontSize: '1.2rem' }}>Relaxe a perna...</p>
            </div>
          )}

          {/* OVERLAY DE FIM DE EXERCÍCIO */}
          {estagio === "FINALIZADO" && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0, 255, 0, 0.3)', zIndex: 25, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
                <div style={{ fontSize: '80px', marginBottom: '10px' }}>🏆</div>
                <h2 style={{ color: 'white', fontSize: '3rem', margin: 0, textShadow: '2px 2px 4px #000' }}>PARABÉNS!</h2>
                <p style={{ color: 'white', fontSize: '1.5rem', textShadow: '1px 1px 2px #000' }}>Exercício Concluído</p>
            </div>
          )}
          
          {/* PLACAR ATUALIZADO COM SÉRIES */}
          <div style={{ position: 'absolute', top: '15px', left: '15px', zIndex: 5, backgroundColor: alertaPostura ? 'rgba(255, 0, 0, 0.9)' : 'rgba(245, 117, 16, 0.9)', padding: '10px 20px', borderRadius: '8px', display: 'flex', gap: '20px', transition: 'background-color 0.3s', opacity: exercicioIniciado ? 1 : 0.3, boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
              <div style={{ borderRight: '1px solid rgba(255,255,255,0.3)', paddingRight: '15px' }}>
                  <div style={{ color: 'black', fontSize: '10px', fontWeight: 'bold' }}>SÉRIE</div>
                  <div style={{ color: 'white', fontSize: '22px', fontWeight: 'bold' }}>{serieAtual} / {configClinica.series}</div>
              </div>
              <div style={{ borderRight: '1px solid rgba(255,255,255,0.3)', paddingRight: '15px' }}>
                  <div style={{ color: 'black', fontSize: '10px', fontWeight: 'bold' }}>REPS</div>
                  <div style={{ color: 'white', fontSize: '22px', fontWeight: 'bold' }}>{repeticoes} / {configClinica.repeticoesPorSerie}</div>
              </div>
              <div>
                  <div style={{ color: 'black', fontSize: '10px', fontWeight: 'bold' }}>ESTADO</div>
                  <div style={{ color: corDoEstado, fontSize: '18px', fontWeight: 'bold', marginTop: '4px' }}>
                      {alertaPostura ? "TRONCO!" : estagio}
                  </div>
              </div>
          </div>

          <video ref={videoRef} autoPlay playsInline style={{ display: 'none' }} />
          <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', transform: 'scaleX(-1)', objectFit: 'cover' }} />
        </div>

        {/* PAINEL CLÍNICO ATUALIZADO */}
        <div style={{ flexShrink: 0, padding: '15px 25px', borderTop: '1px solid #ccc', boxSizing: 'border-box', backgroundColor: '#fff', overflowY: 'auto' }}>
          <h3 style={{ marginTop: 0, marginBottom: '15px', color: '#333', fontSize: '1.2rem', display: 'flex', justifyContent: 'space-between' }}>
            Ajuste Clínico da Sessão
          </h3>
          
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
            {/* LINHA 1: Prescrição */}
            <div style={{ flex: '1 1 20%', minWidth: '100px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px' }}>Séries</label>
              <input type="number" name="series" value={configClinica.series} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '100px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px' }}>Reps / Série</label>
              <input type="number" name="repeticoesPorSerie" value={configClinica.repeticoesPorSerie} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px', color: '#008b8b' }}>Descanso Rep (s)</label>
              <input type="number" name="descansoRepeticao" value={configClinica.descansoRepeticao} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px', color: '#008b8b' }}>Descanso Série (s)</label>
              <input type="number" name="descansoSerie" value={configClinica.descansoSerie} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>

            {/* LINHA 2: Biomecânica */}
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px', color: '#ea580c' }}>LADO ATIVO</label>
              <select name="ladoAtivo" value={configClinica.ladoAtivo} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa', fontWeight: 'bold' }} disabled={exercicioIniciado}>
                <option value="direito">Perna Direita</option>
                <option value="esquerdo">Perna Esquerda</option>
              </select>
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px' }}>Meta Extensão (°)</label>
              <input type="number" name="meta" value={configClinica.meta} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px' }}>Repouso Máx (°)</label>
              <input type="number" name="repousoMax" value={configClinica.repousoMax} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
            <div style={{ flex: '1 1 20%', minWidth: '120px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold', marginBottom: '5px', color: 'red' }}>Limite Tronco (°)</label>
              <input type="number" name="limiteTronco" value={configClinica.limiteTronco} onChange={handleConfigChange} style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #aaa' }} disabled={exercicioIniciado} />
            </div>
          </div>
        </div>
      </div>

      {/* LADO DIREITO */}
      <div style={{ width: '50%', height: '100%', position: 'relative', overflow: 'hidden', backgroundColor: '#fff' }}>
        <Unity unityProvider={unityProvider} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
      </div>

    </div>
  );
};