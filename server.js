const express=require("express");
const multer=require("multer");
const fs=require("fs");
const path=require("path");
const OpenAI=require("openai");

const app=express();
const upload=multer({dest:path.join(__dirname,"uploads")});
const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
app.use(express.json({limit:"10mb"}));
app.use(express.static(__dirname));

const SYSTEM=`Sos ElectroIA, un asistente especializado en electricidad para España y Argentina.
Tu objetivo es ayudar de forma clara, práctica y segura.
Tenés dos modos:
- Hogar: lenguaje sencillo, diagnóstico guiado y seguridad primero.
- Profesional: lenguaje técnico, cálculos, diagnóstico, fotovoltaica, normativa y proyectos.
Nunca inventes una norma. Si no tenés certeza de una exigencia normativa, decilo.
No reemplazás a un electricista habilitado ni un proyecto profesional.
Ante humo, fuego, chispas, olor fuerte a quemado, conductores expuestos o riesgo de electrocución, priorizá cortar la alimentación solo si es seguro y pedir asistencia.
Cuando el usuario no sabe qué preguntar, hacé preguntas concretas de a una para diagnosticar.`;

app.post("/api/chat",async(req,res)=>{
 try{
   const {message,mode="hogar"}=req.body;
   const prompt=`Modo: ${mode}. Usuario: ${message}`;
   const response=await client.responses.create({
     model:"gpt-5.6-luna",
     instructions:SYSTEM,
     input:prompt
   });
   res.json({answer:response.output_text});
 }catch(e){console.error(e);res.status(500).json({error:"Error conectando con la IA."})}
});

app.post("/api/vision",upload.single("image"),async(req,res)=>{
 try{
   if(!req.file)return res.status(400).json({error:"No se recibió imagen."});
   const b64=fs.readFileSync(req.file.path).toString("base64");
   const mime=req.file.mimetype||"image/jpeg";
   const mode=req.body.mode||"hogar";
   const response=await client.responses.create({
     model:"gpt-5.6-luna",
     instructions:SYSTEM+`\nAnalizá la imagen con cuidado. Describí solo lo que realmente puedas observar. Identificá componentes, etiquetas, conexiones visibles y señales de riesgo. Si algo no se puede determinar por la foto, pedí otra imagen o información.`,
     input:[{role:"user",content:[
       {type:"input_text",text:`Modo ${mode}. Analizá esta instalación o componente eléctrico.`},
       {type:"input_image",image_url:`data:${mime};base64,${b64}`}
     ]}]
   });
   fs.unlink(req.file.path,()=>{});
   res.json({answer:response.output_text});
 }catch(e){console.error(e);res.status(500).json({error:"No se pudo analizar la imagen."})}
});

app.post("/api/transcribe",upload.single("audio"),async(req,res)=>{
 try{
   if(!req.file)return res.status(400).json({error:"No se recibió audio."});
   const tr=await client.audio.transcriptions.create({
     model:"gpt-4o-mini-transcribe",
     file:fs.createReadStream(req.file.path),
     language:"es"
   });
   fs.unlink(req.file.path,()=>{});
   res.json({text:tr.text});
 }catch(e){console.error(e);res.status(500).json({error:"No se pudo transcribir el audio."})}
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`ElectroIA IA en http://localhost:${PORT}`));