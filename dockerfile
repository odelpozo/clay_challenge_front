
FROM node:8.15.1-slim

ENV APP_DIR=/usr/src/app \
    NODE_ENV=production \
    PORT=3000
EXPOSE $PORT

# Install as root (otherwise node-gyp gets compiled as nobody)
RUN mkdir -p $APP_DIR

COPY . $APP_DIR

USER root

WORKDIR $APP_DIR/build/bundle/programs/server/

# Copy bundle and scripts to the image APP_DIR(assume bundle in the same folder as Dockerfile)
# COPY bundle $APP_DIR/bundle

# the install command for debian
RUN echo "Installing the node modules..." \
    && npm install -g node-gyp \
    && npm install --production \
    && echo \
    && echo \
    && echo \
    && ls -a \
    && echo "Updating file permissions for the node user..." \
    && chmod -R 750 $APP_DIR \
    && chown -R node.node $APP_DIR \
    && cd $APP_DIR/build/bundle \
    && ls -la

# start the app
WORKDIR $APP_DIR/

USER node

WORKDIR $APP_DIR/bundle
RUN ls -a
WORKDIR $APP_DIR/

# CMD node bundle/main.js --port $PORT

CMD ["npm", "start"]




# # Dockerfile
# FROM node:6.9

# ENV METEOR_ALLOW_SUPERUSER=true
# ENV ROOT_URL="http://localhost:3000"

# RUN curl "https://install.meteor.com/" | sh

# COPY . /usr/src/app
# WORKDIR /usr/src/app

# RUN chmod -R 700 /usr/src/app/.meteor/local
# RUN meteor npm install

# EXPOSE 3000
# CMD ["npm", "start"]