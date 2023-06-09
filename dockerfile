FROM node:14 

RUN curl https://install.meteor.com | /bin/sh

ADD . ./meteorsrc

WORKDIR /meteorsrc

RUN meteor build --directory /var/www/app

WORKDIR /var/www/app

RUN cd bundle/programs/server && npm install

CMD node ./main.js