var require = meteorInstall({"imports":{"api":{"links.js":function module(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// imports/api/links.js                                              //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
module.export({
  LinksCollection: () => LinksCollection
});
let Mongo;
module.link("meteor/mongo", {
  Mongo(v) {
    Mongo = v;
  }
}, 0);
const LinksCollection = new Mongo.Collection('links');
///////////////////////////////////////////////////////////////////////

}}},"server":{"main.js":function module(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// server/main.js                                                    //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
let Meteor;
module.link("meteor/meteor", {
  Meteor(v) {
    Meteor = v;
  }
}, 0);
let LinksCollection;
module.link("/imports/api/links", {
  LinksCollection(v) {
    LinksCollection = v;
  }
}, 1);
function insertLink(_ref) {
  return Promise.asyncApply(() => {
    let {
      title,
      url
    } = _ref;
    Promise.await(LinksCollection.insertAsync({
      title,
      url,
      createdAt: new Date()
    }));
  });
}
Meteor.startup(() => Promise.asyncApply(() => {
  // If the Links collection is empty, add some data.
  if (Promise.await(LinksCollection.find().countAsync()) === 0) {
    Promise.await(insertLink({
      title: 'Do the Tutorial',
      url: 'https://www.meteor.com/tutorials/react/creating-an-app'
    }));
    Promise.await(insertLink({
      title: 'Follow the Guide',
      url: 'https://guide.meteor.com'
    }));
    Promise.await(insertLink({
      title: 'Read the Docs',
      url: 'https://docs.meteor.com'
    }));
    Promise.await(insertLink({
      title: 'Discussions',
      url: 'https://forums.meteor.com'
    }));
  }

  // We publish the entire Links collection to all clients.
  // In order to be fetched in real-time to the clients
  Meteor.publish("links", function () {
    return LinksCollection.find();
  });
}));
///////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json",
    ".ts",
    ".mjs",
    ".jsx"
  ]
});

var exports = require("/server/main.js");
//# sourceURL=meteor://💻app/app/app.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvaW1wb3J0cy9hcGkvbGlua3MuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3NlcnZlci9tYWluLmpzIl0sIm5hbWVzIjpbIm1vZHVsZSIsImV4cG9ydCIsIkxpbmtzQ29sbGVjdGlvbiIsIk1vbmdvIiwibGluayIsInYiLCJDb2xsZWN0aW9uIiwiTWV0ZW9yIiwiaW5zZXJ0TGluayIsInRpdGxlIiwidXJsIiwiaW5zZXJ0QXN5bmMiLCJjcmVhdGVkQXQiLCJEYXRlIiwic3RhcnR1cCIsImZpbmQiLCJjb3VudEFzeW5jIiwicHVibGlzaCJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQUEsTUFBTSxDQUFDQyxNQUFNLENBQUM7RUFBQ0MsZUFBZSxFQUFDLE1BQUlBO0FBQWUsQ0FBQyxDQUFDO0FBQUMsSUFBSUMsS0FBSztBQUFDSCxNQUFNLENBQUNJLElBQUksQ0FBQyxjQUFjLEVBQUM7RUFBQ0QsS0FBSyxDQUFDRSxDQUFDLEVBQUM7SUFBQ0YsS0FBSyxHQUFDRSxDQUFDO0VBQUE7QUFBQyxDQUFDLEVBQUMsQ0FBQyxDQUFDO0FBRXpHLE1BQU1ILGVBQWUsR0FBRyxJQUFJQyxLQUFLLENBQUNHLFVBQVUsQ0FBQyxPQUFPLENBQUMsQzs7Ozs7Ozs7Ozs7QUNGNUQsSUFBSUMsTUFBTTtBQUFDUCxNQUFNLENBQUNJLElBQUksQ0FBQyxlQUFlLEVBQUM7RUFBQ0csTUFBTSxDQUFDRixDQUFDLEVBQUM7SUFBQ0UsTUFBTSxHQUFDRixDQUFDO0VBQUE7QUFBQyxDQUFDLEVBQUMsQ0FBQyxDQUFDO0FBQUMsSUFBSUgsZUFBZTtBQUFDRixNQUFNLENBQUNJLElBQUksQ0FBQyxvQkFBb0IsRUFBQztFQUFDRixlQUFlLENBQUNHLENBQUMsRUFBQztJQUFDSCxlQUFlLEdBQUNHLENBQUM7RUFBQTtBQUFDLENBQUMsRUFBQyxDQUFDLENBQUM7QUFHL0osU0FBZUcsVUFBVTtFQUFBLGdDQUFpQjtJQUFBLElBQWhCO01BQUVDLEtBQUs7TUFBRUM7SUFBSSxDQUFDO0lBQ3RDLGNBQU1SLGVBQWUsQ0FBQ1MsV0FBVyxDQUFDO01BQUVGLEtBQUs7TUFBRUMsR0FBRztNQUFFRSxTQUFTLEVBQUUsSUFBSUMsSUFBSTtJQUFHLENBQUMsQ0FBQztFQUMxRSxDQUFDO0FBQUE7QUFFRE4sTUFBTSxDQUFDTyxPQUFPLENBQUMsK0JBQVk7RUFDekI7RUFDQSxJQUFJLGNBQU1aLGVBQWUsQ0FBQ2EsSUFBSSxFQUFFLENBQUNDLFVBQVUsRUFBRSxNQUFLLENBQUMsRUFBRTtJQUNuRCxjQUFNUixVQUFVLENBQUM7TUFDZkMsS0FBSyxFQUFFLGlCQUFpQjtNQUN4QkMsR0FBRyxFQUFFO0lBQ1AsQ0FBQyxDQUFDO0lBRUYsY0FBTUYsVUFBVSxDQUFDO01BQ2ZDLEtBQUssRUFBRSxrQkFBa0I7TUFDekJDLEdBQUcsRUFBRTtJQUNQLENBQUMsQ0FBQztJQUVGLGNBQU1GLFVBQVUsQ0FBQztNQUNmQyxLQUFLLEVBQUUsZUFBZTtNQUN0QkMsR0FBRyxFQUFFO0lBQ1AsQ0FBQyxDQUFDO0lBRUYsY0FBTUYsVUFBVSxDQUFDO01BQ2ZDLEtBQUssRUFBRSxhQUFhO01BQ3BCQyxHQUFHLEVBQUU7SUFDUCxDQUFDLENBQUM7RUFDSjs7RUFFQTtFQUNBO0VBQ0FILE1BQU0sQ0FBQ1UsT0FBTyxDQUFDLE9BQU8sRUFBRSxZQUFZO0lBQ2xDLE9BQU9mLGVBQWUsQ0FBQ2EsSUFBSSxFQUFFO0VBQy9CLENBQUMsQ0FBQztBQUNKLENBQUMsRUFBQyxDIiwiZmlsZSI6Ii9hcHAuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBNb25nbyB9IGZyb20gJ21ldGVvci9tb25nbyc7XG5cbmV4cG9ydCBjb25zdCBMaW5rc0NvbGxlY3Rpb24gPSBuZXcgTW9uZ28uQ29sbGVjdGlvbignbGlua3MnKTtcbiIsImltcG9ydCB7IE1ldGVvciB9IGZyb20gJ21ldGVvci9tZXRlb3InO1xuaW1wb3J0IHsgTGlua3NDb2xsZWN0aW9uIH0gZnJvbSAnL2ltcG9ydHMvYXBpL2xpbmtzJztcblxuYXN5bmMgZnVuY3Rpb24gaW5zZXJ0TGluayh7IHRpdGxlLCB1cmwgfSkge1xuICBhd2FpdCBMaW5rc0NvbGxlY3Rpb24uaW5zZXJ0QXN5bmMoeyB0aXRsZSwgdXJsLCBjcmVhdGVkQXQ6IG5ldyBEYXRlKCkgfSk7XG59XG5cbk1ldGVvci5zdGFydHVwKGFzeW5jICgpID0+IHtcbiAgLy8gSWYgdGhlIExpbmtzIGNvbGxlY3Rpb24gaXMgZW1wdHksIGFkZCBzb21lIGRhdGEuXG4gIGlmIChhd2FpdCBMaW5rc0NvbGxlY3Rpb24uZmluZCgpLmNvdW50QXN5bmMoKSA9PT0gMCkge1xuICAgIGF3YWl0IGluc2VydExpbmsoe1xuICAgICAgdGl0bGU6ICdEbyB0aGUgVHV0b3JpYWwnLFxuICAgICAgdXJsOiAnaHR0cHM6Ly93d3cubWV0ZW9yLmNvbS90dXRvcmlhbHMvcmVhY3QvY3JlYXRpbmctYW4tYXBwJyxcbiAgICB9KTtcblxuICAgIGF3YWl0IGluc2VydExpbmsoe1xuICAgICAgdGl0bGU6ICdGb2xsb3cgdGhlIEd1aWRlJyxcbiAgICAgIHVybDogJ2h0dHBzOi8vZ3VpZGUubWV0ZW9yLmNvbScsXG4gICAgfSk7XG5cbiAgICBhd2FpdCBpbnNlcnRMaW5rKHtcbiAgICAgIHRpdGxlOiAnUmVhZCB0aGUgRG9jcycsXG4gICAgICB1cmw6ICdodHRwczovL2RvY3MubWV0ZW9yLmNvbScsXG4gICAgfSk7XG5cbiAgICBhd2FpdCBpbnNlcnRMaW5rKHtcbiAgICAgIHRpdGxlOiAnRGlzY3Vzc2lvbnMnLFxuICAgICAgdXJsOiAnaHR0cHM6Ly9mb3J1bXMubWV0ZW9yLmNvbScsXG4gICAgfSk7XG4gIH1cblxuICAvLyBXZSBwdWJsaXNoIHRoZSBlbnRpcmUgTGlua3MgY29sbGVjdGlvbiB0byBhbGwgY2xpZW50cy5cbiAgLy8gSW4gb3JkZXIgdG8gYmUgZmV0Y2hlZCBpbiByZWFsLXRpbWUgdG8gdGhlIGNsaWVudHNcbiAgTWV0ZW9yLnB1Ymxpc2goXCJsaW5rc1wiLCBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIExpbmtzQ29sbGVjdGlvbi5maW5kKCk7XG4gIH0pO1xufSk7XG4iXX0=
