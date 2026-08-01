# Сборка приложения для Amvera.
#
# Приложение лежит в подпапке mini-app, а Amvera собирает из корня репозитория.
# Dockerfile это и решает: берём из корня только то, что нужно приложению.
# Заодно версия Node зафиксирована здесь, а не в настройках панели — видно в коде.

FROM node:22-alpine

WORKDIR /app

# Сначала только списки зависимостей: пока они не менялись, Docker переиспользует
# уже скачанное и не ставит всё заново при каждой правке кода.
COPY mini-app/package.json mini-app/package-lock.json ./
RUN npm ci

COPY mini-app/ ./

RUN npm run build

# Next.js по умолчанию слушает 3000; тот же порт указан в amvera.yaml.
EXPOSE 3000

CMD ["npm", "start"]
