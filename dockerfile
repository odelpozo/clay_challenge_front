FROM node:6.9


ENV METEOR_ALLOW_SUPERUSER=true
# ENV ROOT_URL="http://localhost:3000"
ENV ROOT_URL="https://claychallengefront-production.up.railway.app"

RUN curl "https://install.meteor.com/" -k | sh

RUN PATH="/usr/local/bin/meteor:${PATH}"

ENV PATH="/usr/local/bin/meteor:${PATH}"

RUN meteor --version

RUN npm install --production

COPY . /usr/src/app

WORKDIR /usr/src/app

RUN chmod -R 700 /usr/src/app/.meteor/local

RUN meteor npm install

EXPOSE 3000

CMD ["npm", "start"]