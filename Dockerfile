# Utilise une image Node officielle
FROM node:18

# Définit le répertoire de travail
WORKDIR /app

# Copie les fichiers package.json et package-lock.json
COPY package*.json ./

# Installe les dépendances
RUN npm install

# Copie le reste du projet
COPY . .

# Définit le port exposé
EXPOSE 3000

# Commande pour démarrer le serveur
CMD ["node", "index.js"]
