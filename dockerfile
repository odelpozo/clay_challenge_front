FROM node:14.17.5-alpine

COPY ./build/bundle /bundle

RUN (cd /bundle/programs/server && npm i)

USER node

CMD node /bundle/main.js