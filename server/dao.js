const USERS = [
    {
        id: '1',
        name: 'tester_1',
        roomId: '1',
        isAdmin: 0,
        siteNo: '1'
    },
    {
        id: '2',
        name: 'tester_2',
        roomId: '1',
        isAdmin: 0,
        siteNo: '2'
    },
    {
        id: '3',
        name: 'admin_3',
        roomId: '1',
        isAdmin: 1,
        siteNo: '3'
    },
    {
        id: '4',
        name: 'tester_4',
        roomId: '2',
        isAdmin: 0,
        siteNo: '4'
    },
    {
        id: '5',
        name: 'admin_5',
        roomId: '2',
        isAdmin: 1,
        siteNo: '5'
    }
]

module.exports = {
    getUserBySiteNo: async (num) => {
        let user = USERS.find(u => u.siteNo === num);
        return user
    },

    getUserById: async (id) => {
        let user = USERS.find(u => u.id === id);
        return user
    }
}