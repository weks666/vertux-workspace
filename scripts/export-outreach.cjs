const fs=require('node:fs'),path=require('node:path');
const {banquetPrompt}=require('../outreach.js');
const target=path.resolve(__dirname,'../templates');
fs.mkdirSync(target,{recursive:true});
fs.writeFileSync(path.join(target,'rockefeller-banquet-prompt.txt'),banquetPrompt+'\n','utf8');
fs.writeFileSync(path.join(target,'rockefeller-banquet-columns.csv'),'\uFEFFCompany,Phone,City,Category,Type,Website,Issues,Context,Call_Script,Antigravity_Prompt,VK_Link,Source_URL\n','utf8');
console.log('Rockefeller template files exported. No network or lead data used.');
